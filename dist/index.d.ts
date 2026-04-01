import type { OpenClawPluginApi } from "./types.js";
declare const bridgePlugin: {
    id: string;
    name: string;
    description: string;
    kind: "extension";
    register(api: OpenClawPluginApi): void;
};
export default bridgePlugin;
