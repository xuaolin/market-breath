/* P0 credibility: assemble app from part files */
const __base = new URL("./", import.meta.url);
let __code = "";
for (let __i = 0; __i < 5; __i++) {
  __code += await (await fetch(new URL(`app.p${__i}.txt`, __base))).text();
}
__code = __code.replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, (_m, a, rel, b) => a + new URL(rel, __base).href + b);
const __url = URL.createObjectURL(new Blob([__code], { type: "text/javascript" }));
await import(__url);
