/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { CallStore, ChannelStore, Menu, PermissionsBits, PermissionStore, RestAPI, SelectedChannelStore, showToast, Toasts, UserStore } from "@webpack/common";

interface VoiceRegion {
    id: string;
    name: string;
    optimal: boolean;
    deprecated: boolean;
}

interface CallEvent {
    channel_id: string;
}

interface VoiceStateChangeEvent {
    userId: string;
    channelId?: string;
    oldChannelId?: string;
}

const AUTOMATIC = "";

const regionOptions = [
    { label: "Automatic", value: AUTOMATIC, default: true },
    { label: "Brazil", value: "brazil" },
    { label: "US East", value: "us-east" },
    { label: "US Central", value: "us-central" },
    { label: "US South", value: "us-south" },
    { label: "US West", value: "us-west" },
    { label: "Rotterdam", value: "rotterdam" },
    { label: "Singapore", value: "singapore" },
    { label: "Japan", value: "japan" },
    { label: "Sydney", value: "sydney" }
];

let regions: VoiceRegion[] = [];

const settings = definePluginSettings({
    region: {
        type: OptionType.SELECT,
        description: "Region every call and voice channel you join gets moved to. Automatic leaves Discord in charge.",
        options: regionOptions
    },
    applyToCalls: {
        type: OptionType.BOOLEAN,
        description: "Apply it to DM and group calls.",
        default: true
    },
    applyToGuildChannels: {
        type: OptionType.BOOLEAN,
        description: "Apply it to server voice channels too. This needs Manage Channel, moves the channel for everyone in it, and shows up in the audit log.",
        default: false
    }
});

async function loadRegions() {
    try {
        const { body } = await RestAPI.get({ url: "/voice/regions" });
        regions = (body as VoiceRegion[]).filter(r => !r.deprecated);
        regionOptions.splice(1, regionOptions.length - 1,
            ...regions.map(r => ({ label: r.optimal ? `${r.name} (Discord's pick)` : r.name, value: r.id })));
    } catch (err) {
        console.error("[RegionSwapper] Could not load the voice region list, keeping the built in one.", err);
    }
}

function canManage(channel: Channel) {
    return PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, channel);
}

function currentRegionOf(channel: Channel, isPrivateCall: boolean) {
    return isPrivateCall
        ? CallStore.getCall(channel.id)?.region
        : channel.rtcRegion;
}

async function swap(channelId: string, isPrivateCall: boolean, region: string | null, label: string) {
    const request = isPrivateCall
        ? { url: `/channels/${channelId}/call`, body: { region } }
        : { url: `/channels/${channelId}`, body: { rtc_region: region } };

    try {
        await RestAPI.patch(request);
        showToast(`Voice region: ${label}`, Toasts.Type.SUCCESS);
    } catch (err) {
        showToast(`Couldn't switch to ${label}.`, Toasts.Type.FAILURE);
        console.error("[RegionSwapper] Region swap failed.", err);
    }
}

function autoApply(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;

    const isPrivateCall = channel.isPrivate();
    if (isPrivateCall && !CallStore.getCall(channelId)) return;
    if (!isPrivateCall && !channel.isGuildVoice() && !channel.isGuildStageVoice()) return;

    const { region, applyToCalls, applyToGuildChannels } = settings.store;
    if (region === AUTOMATIC || currentRegionOf(channel, isPrivateCall) === region) return;

    if (isPrivateCall) {
        if (!applyToCalls) return;
    } else {
        if (!applyToGuildChannels) return;
        if (!canManage(channel)) {
            console.log(`[RegionSwapper] Left #${channel.name} alone, you don't have Manage Channel in this server.`);
            return;
        }
    }

    swap(channelId, isPrivateCall, region, regions.find(r => r.id === region)?.name ?? region);
}

const patchContextMenu: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!channel) return;

    const isPrivateCall = channel.isPrivate();
    if (isPrivateCall) {
        if (!CallStore.getCall(channel.id)) return;
    } else {
        if (!channel.isGuildVoice() && !channel.isGuildStageVoice()) return;
        if (!canManage(channel)) return;
    }

    const current = currentRegionOf(channel, isPrivateCall);

    children.push(
        <Menu.MenuItem id="vc-region-swapper" label="Voice Region">
            {!isPrivateCall && (
                <Menu.MenuRadioItem
                    group="vc-region-swapper"
                    id="vc-region-auto"
                    label="Automatic"
                    checked={current == null}
                    action={() => swap(channel.id, false, null, "Automatic")}
                />
            )}
            {regions.map(r => (
                <Menu.MenuRadioItem
                    key={r.id}
                    group="vc-region-swapper"
                    id={`vc-region-${r.id}`}
                    label={r.optimal ? `${r.name} (Discord's pick)` : r.name}
                    checked={current === r.id}
                    action={() => swap(channel.id, isPrivateCall, r.id, r.name)}
                />
            ))}
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "RegionSwapper",
    description: "Pick one voice region and every call and voice channel you join moves to it, for a low ping voice server without routing your whole connection through a VPN.",
    authors: [EquicordDevs.ipedrax],
    tags: ["Voice"],
    settings,

    async start() {
        await loadRegions();

        const current = SelectedChannelStore.getVoiceChannelId();
        if (current) autoApply(current);
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateChangeEvent[]; }) {
            const myId = UserStore.getCurrentUser()?.id;
            if (!myId) return;

            for (const { userId, channelId, oldChannelId } of voiceStates) {
                if (userId !== myId || !channelId || channelId === oldChannelId) continue;
                autoApply(channelId);
            }
        },

        CALL_CREATE({ call }: { call: CallEvent; }) {
            autoApply(call.channel_id);
        },

        CALL_UPDATE({ call }: { call: CallEvent; }) {
            autoApply(call.channel_id);
        }
    },

    contextMenus: {
        "channel-context": patchContextMenu,
        "user-context": patchContextMenu,
        "gdm-context": patchContextMenu
    }
});
