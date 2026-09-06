/* P0 credibility — fetch split gzip-b64 then expand */
const __base = new URL("./", import.meta.url);
const __parts = await Promise.all([0,1].map(i => fetch(new URL(`app.b64.${i}`, __base)).then(r => r.text())));
const __b64 = __parts.join("").replace(/\s+/g, "");
const __bin = Uint8Array.from(atob(__b64), (c) => c.charCodeAt(0));
const __code = await new Response(new Blob([__bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
const __rewritten = __code.replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, (_m,a,rel,b)=>a+new URL(rel,__base).href+b);
await import(URL.createObjectURL(new Blob([__rewritten], { type: "text/javascript" })));
