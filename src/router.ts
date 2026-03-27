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

export function decideRoute(
  currentContext: MessageContext,
  targetAgentId: string,
  registry: RegistryEntry[]
): RouteDecision {
  const target = registry.find(a => a.agentId === targetAgentId);
  if (!target || target.status !== 'online') {
    return { method: 'hub_relay', fallback: 'hub_relay' };
  }

  if (currentContext.isGroupChannel && target.channels) {
    const targetInSameChannel = target.channels.some(
      ch => ch.type === currentContext.channel.type
        && ch.channelId === currentContext.channel.channelId
    );

    if (targetInSameChannel) {
      return {
        method: 'channel_direct',
        channel: currentContext.channel,
        fallback: 'hub_relay',
      };
    }
  }

  return { method: 'hub_relay', fallback: 'hub_relay' };
}
