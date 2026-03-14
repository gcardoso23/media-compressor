import type { NextConfig } from 'next';

const config: NextConfig = {
  // sharp is a native module and has to be loaded from node_modules, not bundled
  serverExternalPackages: ['sharp', 'svgo'],
  devIndicators: false,
  // don't write an AGENTS.md into the project on every dev start
  agentRules: false,
};

export default config;
