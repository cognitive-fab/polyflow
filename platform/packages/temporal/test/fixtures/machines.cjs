// A machine registry as the plugin will generate it at bundle time. Every
// require is a string literal: webpack resolves them statically, and a
// computed path becomes an empty context that fails at run time.
module.exports = {
  'customer-brief': {
    module: require('../../../../examples/customer-brief/machine.cjs'),
    contract: require('../../../../examples/customer-brief/contract.json'),
    mapper: require('../../../../examples/customer-brief/effects.cjs').effects,
    manifest: require('../../../../examples/customer-brief/effects.manifest.json'),
  },
};
