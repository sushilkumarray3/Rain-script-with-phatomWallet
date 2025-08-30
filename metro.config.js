const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const defaultConfig = getDefaultConfig(__dirname);
defaultConfig.resolver ??= {};

// Use maintained npm polyfills, not a local util shim
defaultConfig.resolver.extraNodeModules = {
  ...(defaultConfig.resolver.extraNodeModules || {}),
  util: require.resolve('util/'),
  buffer: require.resolve('buffer/'),
  stream: require.resolve('readable-stream'),
  // Anchor/Solana need this one to resolve correctly:
  'buffer-layout': require.resolve('@solana/buffer-layout'),
};

// Allow ESM modules used by @solana/* (e.g., .mjs)
defaultConfig.resolver.sourceExts = Array.from(
  new Set([...(defaultConfig.resolver.sourceExts || []), 'mjs'])
);

// Prioritize RN/browser fields so Metro picks the right bundle entry
defaultConfig.resolver.mainFields = ['react-native', 'main', 'module'];

module.exports = mergeConfig(defaultConfig, {});
