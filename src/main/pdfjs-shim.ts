/**
 * pdfjs-dist legacy build 启动时会在模块顶层（IIFE 形式）执行：
 *   try { globalThis.DOMMatrix = require("canvas").DOMMatrix } catch (ex) { warn(...) }
 *   try {
 *     const { CanvasRenderingContext2D } = require("canvas");
 *     const { polyfillPath2D } = require("path2d-polyfill");
 *     globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
 *     polyfillPath2D(globalThis);
 *   } catch (ex) { warn(...) }
 *
 * pdfjs-dist 把 `canvas`（即 node-canvas 原版，要 native 编译）列为 optionalDependencies，
 * 我们装的是 @napi-rs/canvas，所以 require("canvas") 走到了 node_modules/canvas（一个 stub），
 * 该 stub 在 require 时就 eager-load bindings.js 去拿 canvas.node，找不到就 throw。
 * 异常被 pdfjs 的 try/catch 吞掉，warn 一句 "Cannot polyfill DOMMatrix" 就过——但
 * globalThis.DOMMatrix 仍是 undefined，后续 page.render() 用到 DOMMatrix 就会失败。
 *
 * 修法：在这个 shim 里先把 globalThis.DOMMatrix / globalThis.Path2D 用 @napi-rs/canvas 的版本填好。
 * 这样 pdfjs 的 checkDOMMatrix() / checkPath2D() 早 return，不会去 require("canvas")。
 * 之所以不用 path2d-polyfill：它需要 globalThis.CanvasRenderingContext2D 才能跑，而
 * @napi-rs/canvas 的 context 类是 SKRSContext2D、并不是 named export CanvasRenderingContext2D，
 * 强塞一个 stub 进去反而会出别的问题。@napi-rs/canvas 自己的 Path2D（NAPI 绑定直接给的）够用。
 */
import { DOMMatrix as NapiDOMMatrix, Path2D as NapiPath2D } from '@napi-rs/canvas';

if (typeof (globalThis as any).DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = NapiDOMMatrix;
}
if (typeof (globalThis as any).Path2D === 'undefined') {
  (globalThis as any).Path2D = NapiPath2D;
}

const pdfjsLib: typeof import('pdfjs-dist') = require('pdfjs-dist/legacy/build/pdf.js');

export = pdfjsLib;
