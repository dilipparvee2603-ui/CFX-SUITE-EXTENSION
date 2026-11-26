/**
 * Dala Suite - YuNet face detector (pure JavaScript, ES5)
 *
 * Runs face_detection_yunet_2023mar (OpenCV Zoo, MIT License) with a tiny executor for the
 * eight ONNX ops the model uses. No ONNX Runtime, WebAssembly or Node.js is required, so face
 * detection works in every CEP panel browser Dala Suite supports.
 *
 * Images are plain objects { width, height, data } where data is RGBA (Uint8ClampedArray /
 * Uint8Array), i.e. the shape of a canvas ImageData.
 */
(function (root) {
    'use strict';

    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    function decodeBase64(str) {
        var lookup = new Uint8Array(256), i;
        for (i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
        var len = str.length, pad = 0;
        if (str.charAt(len - 1) === '=') pad++;
        if (str.charAt(len - 2) === '=') pad++;
        var out = new Uint8Array((len * 3 >> 2) - pad), p = 0, a, b, c, d;
        for (i = 0; i < len; i += 4) {
            a = lookup[str.charCodeAt(i)]; b = lookup[str.charCodeAt(i + 1)];
            c = lookup[str.charCodeAt(i + 2)]; d = lookup[str.charCodeAt(i + 3)];
            out[p++] = (a << 2) | (b >> 4);
            if (p < out.length) out[p++] = ((b & 15) << 4) | (c >> 2);
            if (p < out.length) out[p++] = ((c & 3) << 6) | d;
        }
        return out;
    }

    // ---------------------------------------------------------------- tensor ops (batch = 1)

    // 1x1 convolution, 4 input channels per pass over the output plane.
    function convPointwise(xd, wd, bd, C, O, plane, out, fuseRelu) {
        var o, ic, p, ob, w0, w1, w2, w3, i0, i1, i2, i3, bias;
        for (o = 0; o < O; o++) {
            ob = o * plane;
            bias = bd ? bd[o] : 0;
            for (p = 0; p < plane; p++) out[ob + p] = bias;
            for (ic = 0; ic + 3 < C; ic += 4) {
                w0 = wd[o * C + ic]; w1 = wd[o * C + ic + 1]; w2 = wd[o * C + ic + 2]; w3 = wd[o * C + ic + 3];
                i0 = ic * plane; i1 = i0 + plane; i2 = i1 + plane; i3 = i2 + plane;
                for (p = 0; p < plane; p++) {
                    out[ob + p] += w0 * xd[i0 + p] + w1 * xd[i1 + p] + w2 * xd[i2 + p] + w3 * xd[i3 + p];
                }
            }
            for (; ic < C; ic++) {
                w0 = wd[o * C + ic]; i0 = ic * plane;
                for (p = 0; p < plane; p++) out[ob + p] += w0 * xd[i0 + p];
            }
            if (fuseRelu) { for (p = 0; p < plane; p++) if (out[ob + p] < 0) out[ob + p] = 0; }
        }
    }

    // 3x3 depthwise convolution, stride 1, pad 1: one pass per channel, borders handled separately.
    function convDepthwise3(xd, wd, bd, C, H, W, out, fuseRelu) {
        var c, y, x, base, k, v, wv0, wv1, wv2, wv3, wv4, wv5, wv6, wv7, wv8, r0, r1, r2, o, dy, dx, iy, ix;
        for (c = 0; c < C; c++) {
            base = c * H * W; k = c * 9;
            wv0 = wd[k]; wv1 = wd[k + 1]; wv2 = wd[k + 2]; wv3 = wd[k + 3]; wv4 = wd[k + 4];
            wv5 = wd[k + 5]; wv6 = wd[k + 6]; wv7 = wd[k + 7]; wv8 = wd[k + 8];
            var bias = bd ? bd[c] : 0;
            for (y = 1; y < H - 1; y++) {
                r0 = base + (y - 1) * W; r1 = r0 + W; r2 = r1 + W; o = base + y * W;
                for (x = 1; x < W - 1; x++) {
                    v = bias +
                        wv0 * xd[r0 + x - 1] + wv1 * xd[r0 + x] + wv2 * xd[r0 + x + 1] +
                        wv3 * xd[r1 + x - 1] + wv4 * xd[r1 + x] + wv5 * xd[r1 + x + 1] +
                        wv6 * xd[r2 + x - 1] + wv7 * xd[r2 + x] + wv8 * xd[r2 + x + 1];
                    out[o + x] = (fuseRelu && v < 0) ? 0 : v;
                }
            }
            // border pixels (zero padding)
            for (y = 0; y < H; y++) {
                for (x = 0; x < W; x++) {
                    if (y > 0 && y < H - 1 && x > 0 && x < W - 1) { x = W - 2; continue; }
                    v = bias;
                    for (dy = -1; dy <= 1; dy++) {
                        iy = y + dy; if (iy < 0 || iy >= H) continue;
                        for (dx = -1; dx <= 1; dx++) {
                            ix = x + dx; if (ix < 0 || ix >= W) continue;
                            v += wd[k + (dy + 1) * 3 + dx + 1] * xd[base + iy * W + ix];
                        }
                    }
                    out[base + y * W + x] = (fuseRelu && v < 0) ? 0 : v;
                }
            }
        }
    }

    function conv(x, w, b, a, fuseRelu) {
        var C = x.shape[1], H = x.shape[2], W = x.shape[3];
        var O = w.shape[0], gIn = w.shape[1], KH = w.shape[2], KW = w.shape[3];
        var group = a.group || 1, s = (a.strides || [1, 1])[0];
        var pads = a.pads || [0, 0, 0, 0], pt = pads[0], pl = pads[1];
        var OH = Math.floor((H + pads[0] + pads[2] - KH) / s) + 1;
        var OW = Math.floor((W + pads[1] + pads[3] - KW) / s) + 1;
        var oPlane = OH * OW, iPlane = H * W, gOut = O / group;
        var out = new Float32Array(O * oPlane), xd = x.data, wd = w.data, bd = b ? b.data : null;

        if (KH === 1 && KW === 1 && s === 1 && group === 1) {
            convPointwise(xd, wd, bd, C, O, oPlane, out, fuseRelu);
            return { shape: [1, O, OH, OW], data: out };
        }
        if (KH === 3 && KW === 3 && s === 1 && group === C && O === C && gIn === 1 &&
            pads[0] === 1 && pads[1] === 1 && pads[2] === 1 && pads[3] === 1 && H > 2 && W > 2) {
            convDepthwise3(xd, wd, bd, C, H, W, out, fuseRelu);
            return { shape: [1, O, OH, OW], data: out };
        }

        // general grouped convolution, accumulating every tap of one output pixel in a register
        var o, g, ci, ky, kx, oy, ox, iy, ix, v, wb, ib, iyW, kk;
        var taps = gIn * KH * KW;
        // tap offsets relative to the top-left input pixel, for the bounds-check-free interior
        var offs = [], wIdx = [];
        for (ci = 0; ci < gIn; ci++) for (ky = 0; ky < KH; ky++) for (kx = 0; kx < KW; kx++) {
            offs.push(ci * iPlane + ky * W + kx); wIdx.push((ci * KH + ky) * KW + kx);
        }
        var oxIn0 = Math.ceil(pl / s), oxIn1 = Math.floor((W - KW + pl) / s);
        var oyIn0 = Math.ceil(pt / s), oyIn1 = Math.floor((H - KH + pt) / s);
        var wl = new Float32Array(taps), t, base0, ob2;
        for (o = 0; o < O; o++) {
            g = Math.floor(o / gOut);
            wb = o * taps;
            for (t = 0; t < taps; t++) wl[t] = wd[wb + wIdx[t]];
            var bo = bd ? bd[o] : 0;
            for (oy = 0; oy < OH; oy++) {
                var rowInside = oy >= oyIn0 && oy <= oyIn1;
                ob2 = o * oPlane + oy * OW;
                for (ox = 0; ox < OW; ox++) {
                    if (rowInside && ox >= oxIn0 && ox <= oxIn1) {
                        base0 = g * gIn * iPlane + (oy * s - pt) * W + (ox * s - pl);
                        v = bo;
                        for (t = 0; t < taps; t++) v += wl[t] * xd[base0 + offs[t]];
                        out[ob2 + ox] = (fuseRelu && v < 0) ? 0 : v;
                        continue;
                    }
                    v = bo; kk = wb;
                    for (ci = 0; ci < gIn; ci++) {
                        ib = (g * gIn + ci) * iPlane;
                        for (ky = 0; ky < KH; ky++) {
                            iy = oy * s - pt + ky;
                            if (iy < 0 || iy >= H) { kk += KW; continue; }
                            iyW = ib + iy * W;
                            for (kx = 0; kx < KW; kx++, kk++) {
                                ix = ox * s - pl + kx;
                                if (ix >= 0 && ix < W) v += wd[kk] * xd[iyW + ix];
                            }
                        }
                    }
                    out[o * oPlane + oy * OW + ox] = (fuseRelu && v < 0) ? 0 : v;
                }
            }
        }
        return { shape: [1, O, OH, OW], data: out };
    }

    function relu(x) {
        var d = new Float32Array(x.data.length), s = x.data;
        for (var i = 0; i < d.length; i++) d[i] = s[i] > 0 ? s[i] : 0;
        return { shape: x.shape.slice(), data: d };
    }

    function sigmoid(x) {
        var d = new Float32Array(x.data.length), s = x.data;
        for (var i = 0; i < d.length; i++) d[i] = 1 / (1 + Math.exp(-s[i]));
        return { shape: x.shape.slice(), data: d };
    }

    function add(x, y) {
        var d = new Float32Array(x.data.length), a = x.data, b = y.data;
        for (var i = 0; i < d.length; i++) d[i] = a[i] + b[i];
        return { shape: x.shape.slice(), data: d };
    }

    function maxPool2(x) {
        var C = x.shape[1], H = x.shape[2], W = x.shape[3];
        var OH = Math.floor(H / 2), OW = Math.floor(W / 2);
        var out = new Float32Array(C * OH * OW), s = x.data, c, y, xx, i, v, m;
        for (c = 0; c < C; c++) {
            for (y = 0; y < OH; y++) {
                for (xx = 0; xx < OW; xx++) {
                    i = c * H * W + (2 * y) * W + 2 * xx;
                    m = s[i]; v = s[i + 1]; if (v > m) m = v;
                    v = s[i + W]; if (v > m) m = v;
                    v = s[i + W + 1]; if (v > m) m = v;
                    out[(c * OH + y) * OW + xx] = m;
                }
            }
        }
        return { shape: [1, C, OH, OW], data: out };
    }

    function resizeNearest2(x) {
        var C = x.shape[1], H = x.shape[2], W = x.shape[3], OH = H * 2, OW = W * 2;
        var out = new Float32Array(C * OH * OW), s = x.data, c, y, xx;
        for (c = 0; c < C; c++) {
            for (y = 0; y < OH; y++) {
                var srow = c * H * W + (y >> 1) * W, orow = (c * OH + y) * OW;
                for (xx = 0; xx < OW; xx++) out[orow + xx] = s[srow + (xx >> 1)];
            }
        }
        return { shape: [1, C, OH, OW], data: out };
    }

    function transposeNHWC(x) {
        var C = x.shape[1], H = x.shape[2], W = x.shape[3], plane = H * W;
        var out = new Float32Array(x.data.length), s = x.data, c, p;
        for (p = 0; p < plane; p++) for (c = 0; c < C; c++) out[p * C + c] = s[c * plane + p];
        return { shape: [1, H, W, C], data: out };
    }

    function reshape(x, shape) {
        var total = x.data.length, known = 1, neg = -1, i, s = shape.slice();
        for (i = 0; i < s.length; i++) { if (s[i] === -1) neg = i; else known *= s[i]; }
        if (neg >= 0) s[neg] = total / known;
        return { shape: s, data: x.data };
    }

    // ---------------------------------------------------------------- model

    function Net(model) {
        var raw = decodeBase64(model.data);
        var floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
        this.model = model;
        this.weights = {};
        for (var k in model.tensors) {
            if (!model.tensors.hasOwnProperty(k)) continue;
            var t = model.tensors[k];
            this.weights[k] = { shape: t[2], data: floats.subarray(t[0], t[0] + t[1]) };
        }
        // free intermediate tensors as soon as their last consumer has run
        this.lastUse = {};
        var uses = {}, n, j, ins;
        for (n = 0; n < model.nodes.length; n++) {
            ins = model.nodes[n].i;
            for (j = 0; j < ins.length; j++) { this.lastUse[ins[j]] = n; uses[ins[j]] = (uses[ins[j]] || 0) + 1; }
        }
        // a Conv whose only consumer is a Relu applies the Relu itself; the Relu becomes a pass-through
        this.fused = {};
        for (n = 0; n < model.nodes.length; n++) {
            var nd = model.nodes[n];
            if (nd.op === 'Relu' && uses[nd.i[0]] === 1) {
                for (j = 0; j < n; j++) {
                    if (model.nodes[j].op === 'Conv' && model.nodes[j].o[0] === nd.i[0]) { this.fused[j] = true; this.fused[n] = true; break; }
                }
            }
        }
    }

    Net.prototype.run = function (input) {
        var env = {}, nodes = this.model.nodes, W = this.weights, outs = {}, i, j;
        var get = function (name) { return env[name] || W[name]; };
        env[this.model.input] = input;
        var isOut = {};
        for (i = 0; i < this.model.outputs.length; i++) isOut[this.model.outputs[i]] = true;
        for (i = 0; i < nodes.length; i++) {
            var nd = nodes[i];
            var x = get(nd.i[0]), r;
            switch (nd.op) {
                case 'Conv': r = conv(x, get(nd.i[1]), nd.i[2] ? get(nd.i[2]) : null, nd.a, !!this.fused[i]); break;
                case 'Relu': r = this.fused[i] ? x : relu(x); break;
                case 'Sigmoid': r = sigmoid(x); break;
                case 'Add': r = add(x, get(nd.i[1])); break;
                case 'MaxPool': r = maxPool2(x); break;
                case 'Resize': r = resizeNearest2(x); break;
                case 'Transpose': r = transposeNHWC(x); break;
                case 'Reshape': r = reshape(x, nd.a.shape); break;
                default: throw new Error('YuNet: unsupported op ' + nd.op);
            }
            env[nd.o[0]] = r;
            if (isOut[nd.o[0]]) outs[nd.o[0]] = r;
            for (j = 0; j < nd.i.length; j++) {
                if (this.lastUse[nd.i[j]] === i && !isOut[nd.i[j]] && env[nd.i[j]]) delete env[nd.i[j]];
            }
        }
        return outs;
    };

    // ---------------------------------------------------------------- pre / post processing

    // RGBA image -> 1x3xHxW BGR float blob (0..255, no normalisation, like cv::dnn::blobFromImage),
    // scaled by `scale` and zero-padded to inW x inH. Area-averages when shrinking.
    function makeBlob(img, scale, inW, inH) {
        var sw = img.width, sh = img.height, src = img.data;
        var dw = Math.min(inW, Math.round(sw * scale)), dh = Math.min(inH, Math.round(sh * scale));
        var plane = inW * inH, out = new Float32Array(3 * plane);
        var fx = sw / dw, fy = sh / dh, x, y, sx0, sx1, sy0, sy1, xx, yy, r, g, b, n, si, o;
        for (y = 0; y < dh; y++) {
            sy0 = Math.floor(y * fy); sy1 = Math.max(sy0 + 1, Math.min(sh, Math.floor((y + 1) * fy)));
            for (x = 0; x < dw; x++) {
                sx0 = Math.floor(x * fx); sx1 = Math.max(sx0 + 1, Math.min(sw, Math.floor((x + 1) * fx)));
                r = 0; g = 0; b = 0; n = 0;
                for (yy = sy0; yy < sy1; yy++) {
                    si = (yy * sw + sx0) * 4;
                    for (xx = sx0; xx < sx1; xx++) { r += src[si]; g += src[si + 1]; b += src[si + 2]; si += 4; n++; }
                }
                o = y * inW + x;
                out[o] = b / n; out[plane + o] = g / n; out[2 * plane + o] = r / n;
            }
        }
        return { shape: [1, 3, inH, inW], data: out };
    }

    function iou(a, b) {
        var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        var x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
        var inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        var uni = a.w * a.h + b.w * b.h - inter;
        return uni > 0 ? inter / uni : 0;
    }

    function nms(boxes, thr, topK) {
        boxes.sort(function (p, q) { return q.score - p.score; });
        var keep = [], i, j, ok;
        for (i = 0; i < boxes.length && keep.length < topK; i++) {
            ok = true;
            for (j = 0; j < keep.length; j++) { if (iou(boxes[i], keep[j]) > thr) { ok = false; break; } }
            if (ok) keep.push(boxes[i]);
        }
        return keep;
    }

    function decode(outs, inW, inH, scale, thr) {
        var strides = [8, 16, 32], res = [], s, k;
        for (k = 0; k < 3; k++) {
            s = strides[k];
            var cols = inW / s, rows = inH / s;
            var cls = outs['cls_' + s].data, obj = outs['obj_' + s].data;
            var bb = outs['bbox_' + s].data, kp = outs['kps_' + s].data;
            for (var r = 0; r < rows; r++) {
                for (var c = 0; c < cols; c++) {
                    var idx = r * cols + c;
                    var cs = Math.min(1, Math.max(0, cls[idx])), os = Math.min(1, Math.max(0, obj[idx]));
                    var score = Math.sqrt(cs * os);
                    if (score < thr) continue;
                    var cx = (c + bb[idx * 4]) * s, cy = (r + bb[idx * 4 + 1]) * s;
                    var w = Math.exp(bb[idx * 4 + 2]) * s, h = Math.exp(bb[idx * 4 + 3]) * s;
                    var kps = [];
                    for (var j = 0; j < 5; j++) {
                        kps.push((kp[idx * 10 + 2 * j] + c) * s / scale, (kp[idx * 10 + 2 * j + 1] + r) * s / scale);
                    }
                    res.push({ x: (cx - w / 2) / scale, y: (cy - h / 2) / scale, w: w / scale, h: h / scale, score: score, kps: kps });
                }
            }
        }
        return res;
    }

    function Detector(model) {
        this.net = new Net(model || root.DalaYuNetModel);
    }

    /**
     * detect(img, opts) -> [{ x, y, w, h, score, kps:[x0,y0..x4,y4] }] in image pixels, best first.
     * opts.maxSide (default 640): the longest image side is scaled to this before inference.
     */
    Detector.prototype.detect = function (img, opts) {
        opts = opts || {};
        var maxSide = opts.maxSide || 640;
        var scale = maxSide / Math.max(img.width, img.height);
        var inW = Math.max(32, Math.ceil(img.width * scale / 32) * 32);
        var inH = Math.max(32, Math.ceil(img.height * scale / 32) * 32);
        var outs = this.net.run(makeBlob(img, scale, inW, inH));
        var boxes = decode(outs, inW, inH, scale, opts.scoreThreshold != null ? opts.scoreThreshold : 0.6);
        return nms(boxes, opts.nmsThreshold != null ? opts.nmsThreshold : 0.3, opts.topK || 50);
    };

    var api = { Detector: Detector, Net: Net, makeBlob: makeBlob, iou: iou, decodeBase64: decodeBase64 };
    root.DalaYuNet = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
