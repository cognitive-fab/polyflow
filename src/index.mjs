// polyflow's public surface — the boundary polycrew depends on.
//
// Four things, two of which a layer above replaces: it brings its own broker
// (polycrew's is store-backed and shared between processes) and its own extra
// tools, and uses the library and the engine as they are. Nothing else here is
// a supported import; reaching past this file is how the split rots.
//
// See docs/polycrew-spec.html §0b and docs/polycrew-c0-plan.md.

export { Library, deriveKey } from './library.mjs';
export { Polyflow } from './daemon.mjs';
export { Broker } from './broker.mjs';
export { makeTools } from './tools.mjs';

// The MCP stdio server and the area vocabulary, shared rather than reimplemented.
export { serve } from './mcp.mjs';
export { Area } from './areas.mjs';
