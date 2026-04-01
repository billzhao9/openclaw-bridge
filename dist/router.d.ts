import type { RegistryEntry, ChannelInfo } from './types.js';
export interface MessageContext {
    channel: ChannelInfo;
    isGroupChannel: boolean;
}
export interface RouteDecision {
    method: 'channel_direct' | 'hub_relay';
    channel?: ChannelInfo;
    fallback: 'hub_relay';
}
export declare function decideRoute(currentContext: MessageContext, targetAgentId: string, registry: RegistryEntry[]): RouteDecision;
