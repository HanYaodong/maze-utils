import { waitFor } from ".";
import { LocalStorage, ProtoConfig, SyncStorage, isSafari } from "./config";
import { getElement, isVisible, waitForElement } from "./dom";
import { newThumbnails } from "./thumbnailManagement";
import { YT_DOMAINS } from "./const";
import { addCleanupListener, setupCleanupListener } from "./cleanup";
import { injectScript } from "./scriptInjector";

export enum PageType {
    Unknown = "unknown",
    Shorts = "shorts",
    Watch = "watch",
    Search = "search",
    Browse = "browse",
    Channel = "channel",
    Embed = "embed"
}
export type VideoID = string & { __videoID: never };
export type ChannelID = string & { __channelID: never };
export enum ChannelIDStatus {
    Fetching,
    Found,
    Failed
}
export interface ChannelIDInfo {
    id: ChannelID | null;
    status: ChannelIDStatus;
}
export interface ParsedVideoURL {
    videoID: VideoID | null;
    onInvidious: boolean;
    onMobileYouTube: boolean;
    callLater: boolean;
}

interface VideoModuleParams {
    videoIDChange: (videoID: VideoID) => void;
    channelIDChange: (channelIDInfo: ChannelIDInfo) => void;
    videoElementChange?: (newVideo: boolean, video: HTMLVideoElement | null) => void;
    playerInit?: () => void;
    updatePlayerBar?: () => void;
    resetValues: () => void;
    windowListenerHandler?: (event: MessageEvent) => void;
    newVideosLoaded?: (videoIDs: VideoID[]) => void; // Used to pre-cache data for videos
    documentScript: string;
    allowClipPage?: boolean;
}

const embedTitleSelector = "a.ytp-title-link[data-sessionlink='feature=player-title']:not(.cbCustomTitle)";

let video: HTMLVideoElement | null = null;
let videoWidth: string | null = null;
let videoMutationObserver: MutationObserver | null = null;
let videoMutationListenerElement: HTMLElement | null = null;
// What videos have run through setup so far
const videosSetup: HTMLVideoElement[] = [];
let waitingForNewVideo = false;

let isAdPlaying = false;
// if video is live or premiere
let isLivePremiere: boolean

let videoID: VideoID | null = null;
let onInvidious: boolean | null = null;
let onMobileYouTube = false;
let pageType: PageType = PageType.Unknown;
let channelIDInfo: ChannelIDInfo;
let waitingForChannelID = false;
let lastNonInlineVideoID: VideoID | null = null;
let isInline = false;
// For server-side rendered ads
let adDuration = 0;
// If server-side ad couldn't be removed from current time properly
let currentTimeWrong = false;

let params: VideoModuleParams = {
    videoIDChange: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    channelIDChange: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    videoElementChange: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    playerInit: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    resetValues: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    windowListenerHandler: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    newVideosLoaded: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    documentScript: "",
    allowClipPage: false
};
let getConfig: () => ProtoConfig<SyncStorage, LocalStorage>;
export function setupVideoModule(moduleParams: VideoModuleParams, config: () => ProtoConfig<SyncStorage, LocalStorage>) {
    params = moduleParams;
    getConfig = config;

    setupCleanupListener();

    // Direct Links after the config is loaded
    void waitFor(() => getConfig().isReady(), 1000, 1).then(() => videoIDChange(getYouTubeVideoID()));

    // Can't use onInvidious at this point, the configuration might not be ready.
    if (YT_DOMAINS.includes(location.host) && document.URL.includes("/embed/")) {
        waitForElement(embedTitleSelector)
            .then((e) => waitFor(() => e.getAttribute("href")))
            .then(() => videoIDChange(getYouTubeVideoID()))
            // Ignore if not an embed
            .catch(() => {}); // eslint-disable-line @typescript-eslint/no-empty-function
    }

    addPageListeners();

    // Register listener for URL change via Navigation API
    const navigationApiAvailable = "navigation" in window;
    if (navigationApiAvailable) {
        // TODO: Remove type cast once type declarations are updated
        const navigationListener = (e) =>
            void videoIDChange(getYouTubeVideoID((e as unknown as Record<string, Record<string, string>>).destination.url));
        (window as unknown as { navigation: EventTarget }).navigation.addEventListener("navigate", navigationListener);

        addCleanupListener(() => {
            (window as unknown as { navigation: EventTarget }).navigation.removeEventListener("navigate", navigationListener);
        });
    }
    // Record availability of Navigation API
    void waitFor(() => config().local !== null).then(() => {
        if (config().local!.navigationApiAvailable !== navigationApiAvailable) {
            config().local!.navigationApiAvailable = navigationApiAvailable;
            config().forceLocalUpdate("navigationApiAvailable");
        }
    });

    setupVideoMutationListener();

    addCleanupListener(() => {
        if (videoMutationObserver) {
            videoMutationObserver.disconnect();
            videoMutationObserver = null;
        }
    });
}

export async function checkIfNewVideoID(): Promise<boolean> {
    const id = getYouTubeVideoID();

    if (id === videoID) return false;
    return await videoIDChange(id);
}

export async function checkVideoIDChange(): Promise<boolean> {
    const id = getYouTubeVideoID();
    
    return await videoIDChange(id);
}

export async function triggerVideoIDChange(id: VideoID): Promise<boolean> {
    return await videoIDChange(id);
}

async function videoIDChange(id: VideoID | null, isInlineParam = false): Promise<boolean> {
    // don't switch to invalid value
    if (!id && videoID &&
            (params.allowClipPage || !document?.URL?.includes("youtube.com/clip/"))) {
        return false;
    }

    if (isInlineParam && id) {
        setTimeout(() => void refreshVideoAttachments(), 200);
        setTimeout(() => void refreshVideoAttachments(), 1000);
    }

    //if the id has not changed return unless the video element has changed
    if (videoID === id && (isVisible(video) || !video)) return false;

    // Make sure the video is still visible
    if (!isVisible(video)) {
        void refreshVideoAttachments();
    }

    resetValues();
    videoID = id;
    isInline = isInlineParam;

	//id is not valid
    if (!id) return false;

    // Wait for options to be ready
    await waitFor(() => getConfig().isReady(), 5000, 1);

    // Update whitelist data when the video data is loaded
    void whitelistCheck();

    params.videoIDChange(id);

    return true;
}

function resetValues() {
    params.resetValues();

    videoID = null;
    pageType = PageType.Unknown;
    channelIDInfo = {
        status: ChannelIDStatus.Fetching,
        id: null
    };
    isLivePremiere = false;
    isInline = false;
    adDuration = 0;
    currentTimeWrong = false;

    isAdPlaying = false;

    // Reset the last media session link
    window.postMessage({
        source: "sb-reset-media-session-link",
        videoID: null
    }, "/");
}

export function getYouTubeVideoID(url?: string): VideoID | null {
    url ||= document?.URL;
    // pageType shortcut
    if (pageType === PageType.Channel) return getYouTubeVideoIDFromDocument();
    // clips should never skip, going from clip to full video has no indications.
    if (!params.allowClipPage && url.includes("youtube.com/clip/")) return null;
    // skip to document and don't hide if on /embed/
    if (url.includes("/embed/") && url.includes("youtube.com")) return getYouTubeVideoIDFromDocument(false, PageType.Embed);
    // skip to URL if matches youtube watch or invidious or matches youtube pattern
    if ((!url.includes("youtube.com")) || url.includes("/watch") || url.includes("/shorts/") || url.includes("playlist")) return getYouTubeVideoIDFromURL(url);
    // skip to document if matches pattern
    if (url.includes("/channel/") || url.includes("/user/") || url.includes("/c/")) return getYouTubeVideoIDFromDocument(true, PageType.Channel);
    // not sure, try URL then document
    return getYouTubeVideoIDFromURL(url) || getYouTubeVideoIDFromDocument(false);
}

function getYouTubeVideoIDFromDocument(hideIcon = true, pageHint = PageType.Watch): VideoID | null {
    // get ID from document (channel trailer / embedded playlist)
    const element = pageHint === PageType.Embed ? document.querySelector(embedTitleSelector)
        : video?.parentElement?.parentElement?.querySelector(embedTitleSelector);
    const videoURL = element?.getAttribute("href");
    if (videoURL) {
        onInvidious = hideIcon;
        // if href found, hint was correct
        pageType = pageHint;
        return getYouTubeVideoIDFromURL(videoURL);
    } else {
        return null;
    }
}

/**
 * Parse with side effects
 */
function getYouTubeVideoIDFromURL(url: string): VideoID | null {
    const result = parseYouTubeVideoIDFromURL(url);

    if (result.callLater) {
        // Call this later, in case this is an Invidious tab
        void waitFor(() => getConfig().isReady()).then(() => videoIDChange(getYouTubeVideoIDFromURL(url)));

        return null;
    }

    onInvidious = result.onInvidious;
    onMobileYouTube = result.onMobileYouTube;

    return result.videoID;
}

/**
 * Parse without side effects
 */
export function parseYouTubeVideoIDFromURL(url: string): ParsedVideoURL {
    if (url.startsWith("https://www.youtube.com/tv#/")) url = url.replace("#", "");
    if (url.startsWith("https://www.youtube.com/tv?")) url = url.replace(/\?[^#]+#/, "");
    let onInvidious = false;
    let onMobileYouTube = false;

    //Attempt to parse url
    let urlObject: URL | null = null;
    try {
        urlObject = new URL(url);
    } catch (e) {
        console.error("[SB] Unable to parse URL: " + url);
        return {
            videoID: null,
            onInvidious,
            onMobileYouTube,
            callLater: false
        };
    }

    // Check if valid hostname
    if (YT_DOMAINS.includes(urlObject.host)) {
        // on YouTube
        if (urlObject.host === "m.youtube.com") onMobileYouTube = true;
        onInvidious = false;
    } else if (getConfig().isReady() && getConfig().config!.invidiousInstances?.includes(urlObject.hostname)) {
        onInvidious = true;
    } else { // fail to invidious
        return {
            videoID: null,
            onInvidious,
            onMobileYouTube,
            callLater: !getConfig().isReady() // Might be an Invidious tab
        };
    }

    //Get ID from searchParam
    if (urlObject.searchParams.has("v") && ["/watch", "/watch/"].includes(urlObject.pathname) || urlObject.pathname.startsWith("/tv/watch")) {
        const id = urlObject.searchParams.get("v");
        return {
            videoID: id?.length == 11 ? id as VideoID : null,
            onInvidious,
            onMobileYouTube,
            callLater: false
        };
    } else if (urlObject.pathname.startsWith("/embed/") || urlObject.pathname.startsWith("/shorts/")) {
        try {
            const id = urlObject.pathname.split("/")[2]
            if (id?.length >= 11 ) return {
                videoID: id.slice(0, 11) as VideoID,
                onInvidious,
                onMobileYouTube,
                callLater: false
            };
        } catch (e) {
            console.error("[SB] Video ID not valid for " + url);
            return {
                videoID: null,
                onInvidious,
                onMobileYouTube,
                callLater: false
            };
        }
    }

    return {
        videoID: null,
        onInvidious,
        onMobileYouTube,
        callLater: false
    };
}

//checks if this channel is whitelisted, should be done only after the channelID has been loaded
export async function whitelistCheck() {
    try {
        waitingForChannelID = true;
        await waitFor(() => channelIDInfo.status === ChannelIDStatus.Found, 6000, 20);

        // If found, continue on, it was set by the listener
    } catch (e) {
        // try to get channelID from page-manager
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pageMangerChannelID = (document.querySelector("ytd-page-manager") as any)?.data?.playerResponse?.videoDetails?.channelId

        // Try fallback
        const channelIDFallback = (document.querySelector("a.ytd-video-owner-renderer") // YouTube
            ?? document.querySelector("a.ytp-title-channel-logo") // YouTube Embed
            ?? document.querySelector(".channel-profile #channel-name")?.parentElement?.parentElement // Invidious
            ?? document.querySelector("a.slim-owner-icon-and-title")) // Mobile YouTube
                ?.getAttribute("href")?.match(/\/(?:(?:channel|c|user|)\/|@)(UC[a-zA-Z0-9_-]{22}|[a-zA-Z0-9_-]+)/)?.[1];

        if (channelIDFallback) {
            channelIDInfo = {
                status: ChannelIDStatus.Found,
                id: (pageMangerChannelID ?? channelIDFallback) as ChannelID
            };
        } else {
            channelIDInfo = {
                status: ChannelIDStatus.Failed,
                id: null
            };
        }
    }

    waitingForChannelID = false;
    params.channelIDChange(channelIDInfo);
}

let lastMutationListenerCheck = 0;
let checkTimeout: NodeJS.Timeout | null = null;
function setupVideoMutationListener() {
    if (!onInvidious 
            && (videoMutationObserver === null || !isVisible(videoMutationListenerElement!.parentElement))) {

        // Delay it if it was checked recently
        if (checkTimeout) clearTimeout(checkTimeout);
        if (Date.now() - lastMutationListenerCheck < 2000) {
            checkTimeout = setTimeout(setupVideoMutationListener, Math.max(1000, Date.now() - lastMutationListenerCheck));
            return;
        }

        lastMutationListenerCheck = Date.now();
        const mainVideoObject = getElement("#movie_player", true);
        if (!mainVideoObject) return;

        const videoContainer = mainVideoObject.querySelector(".html5-video-container") as HTMLElement;
        if (!videoContainer) return;

        if (videoMutationObserver) videoMutationObserver.disconnect();
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        videoMutationObserver = new MutationObserver(refreshVideoAttachments);
        videoMutationListenerElement = videoContainer;

        videoMutationObserver.observe(videoContainer, {
            attributes: true,
            childList: true,
            subtree: true
        });
    }
}

// Used only for embeds to wait until the url changes
let embedLastUrl = "";
let waitingForEmbed = false;

async function refreshVideoAttachments(): Promise<void> {
    if (waitingForNewVideo) return;

    if (!isVisible(video) && !isVinegarActive()) video = null;

    waitingForNewVideo = true;
    // Compatibility for Vinegar extension
    let newVideo = (isSafari() && document.querySelector('video[vinegared="true"]') as HTMLVideoElement) 
        || await waitForElement("video", true) as HTMLVideoElement;
    let durationChange = false;

    // To handle the case with a paused miniplayer while playing a hover preview
    const isOnMiniplayer = !!document.querySelector(".miniplayer video");
    if (isOnMiniplayer && newVideo) {
        const possibleVideos = [...document.querySelectorAll("video")].filter((v) => isVisible(v));
        if (possibleVideos.length > 1) {
            const oldDuration = newVideo.duration;
            const nonMiniplayerVideo = possibleVideos.find((v) => !v.closest(".miniplayer")) as HTMLVideoElement;
            if (nonMiniplayerVideo) newVideo = nonMiniplayerVideo;

            if (isNaN(newVideo.duration)) {
                await waitFor(() => !!newVideo.duration, 5000, 50);
            }

            durationChange = oldDuration !== newVideo.duration;
        }
    }

    waitingForNewVideo = false;

    // Width used because sometimes video element is copied to a new place
    if (video === newVideo && videoWidth === newVideo.style.width && !durationChange) return;

    video = newVideo;
    videoWidth = newVideo.style.width;
    const isNewVideo = !videosSetup.includes(video);

    if (isNewVideo) {
        videosSetup.push(video);
    }

    params.videoElementChange?.(isNewVideo, video);
    setupVideoMutationListener();

    if (document.URL.includes("/embed/")) {
        if (waitingForEmbed) {
            return;
        }
        waitingForEmbed = true;

        const waiting = waitForElement(embedTitleSelector)
            .then((e) => waitFor(() => e, undefined, undefined, (e) => e.getAttribute("href") !== embedLastUrl 
                && !!e.getAttribute("href") && !!e.textContent));

        void waiting.catch(() => waitingForEmbed = false);
        void waiting.then((e) => embedLastUrl = e.getAttribute("href")!)
            .then(() => waitingForEmbed = false)
            .then(() => videoIDChange(getYouTubeVideoID()));
    } else {
        void videoIDChange(getYouTubeVideoID());
    }
}

/**
 * To handle compatibility with the Vinegar extension on Safari
 */
function isVinegarActive(): boolean {
    return isSafari() && !!document.querySelector('video[vinegared="true"]');
}

export function triggerVideoElementChange(newVideo: HTMLVideoElement): void {
    video = newVideo;
    videoWidth = newVideo.style.width;
    const isNewVideo = !videosSetup.includes(video);

    if (isNewVideo) {
        videosSetup.push(video);
    }

    params.videoElementChange?.(isNewVideo, video);
}

function windowListenerHandler(event: MessageEvent): void {
    const data = event.data;
    const dataType = data.type;

    if (data.source !== "sponsorblock"
        || (!params.allowClipPage && document?.URL?.includes("youtube.com/clip/"))) return;

    if (dataType === "navigation") {
        newThumbnails();
    }

    if (dataType === "navigation" && data.videoID) {
        pageType = data.pageType;

        if (data.channelID) {
            channelIDInfo = {
                id: data.channelID,
                status: ChannelIDStatus.Found
            };

            if (!waitingForChannelID) {
                void whitelistCheck();
            }
        }

        void videoIDChange(data.videoID);
    } else if (dataType === "ad") {
        if (isAdPlaying != data.playing) {
            isAdPlaying = data.playing
            
            params.updatePlayerBar?.();
        }
    } else if (dataType === "data" && data.videoID) {
        if (!data.isInline) {
            lastNonInlineVideoID = data.videoID;
        }

        void videoIDChange(data.videoID, data.isInline);

        isLivePremiere = data.isLive || data.isPremiere
    } else if (dataType === "newElement") {
        newThumbnails();
    } else if (dataType === "videoIDsLoaded") {
        params.newVideosLoaded?.(data.videoIDs);
    } else if (dataType === "adDuration") {
        adDuration = data.duration;
    } else if (dataType === "currentTimeWrong") {
        currentTimeWrong = true;

        alert(chrome.i18n.getMessage("submissionFailedServerSideAds"));
    }

    params.windowListenerHandler?.(event);
}

function addPageListeners(): void {
    const refreshListeners = () => {
        if (!isVisible(video)) {
            void refreshVideoAttachments();
        }
    };

    if (params.documentScript) {
        injectScript(params.documentScript);
    }

    document.addEventListener("yt-navigate-finish", refreshListeners);
    // piped player init
    const playerInitListener = () => {
        if (!document.querySelector('meta[property="og:title"][content="Piped"]')) return;
        params.playerInit?.();
    };
    window.addEventListener("playerInit", playerInitListener);
    window.addEventListener("message", windowListenerHandler);

    addCleanupListener(() => {
        document.removeEventListener("yt-navigate-finish", refreshListeners);
        window.removeEventListener("playerInit", playerInitListener);
        window.removeEventListener("message", windowListenerHandler);
    });
}

let lastRefresh = 0;
export function getVideo(): HTMLVideoElement | null {
    setupVideoMutationListener();

    if ((!isVisible(video)
            || (onMobileYouTube && video && isNaN(video.duration)))
            && Date.now() - lastRefresh > 500) {
        lastRefresh = Date.now();
        if (!isVisible(video) && !isVinegarActive()) video = null;
        void refreshVideoAttachments();
    }

    return video;
}

export function getVideoID(): VideoID | null {
    return videoID;
}

export function getVideoDuration(): number {
    return Math.max(0, (video?.duration ?? 0) - adDuration);
}

export function getCurrentTime(): number | undefined {
    const time = getVideo()?.currentTime;
    if (time) {
        return time - adDuration;
    } else {
        return time;
    }
}

// Called when creating time to verify there aren't any
//   undetected server-side ads causing issues
export function verifyCurrentTime() {
    if (getVideo() && getVideo()!.paused) {
        window.postMessage({
            source: "sb-verify-time",
            time: getCurrentTime()
        }, "/");
    }
}

export function setCurrentTime(time: number): void {
    if (getVideo()) {
        getVideo()!.currentTime = time + adDuration;
    }
}

export function isOnInvidious(): boolean | null {
    return onInvidious;
}

export function isOnMobileYouTube(): boolean {
    return onMobileYouTube;
}

export function getWaitingForChannelID(): boolean {
    return waitingForChannelID;
}

export function getChannelIDInfo(): ChannelIDInfo {
    return channelIDInfo;
}

export function getIsAdPlaying(): boolean {
    return isAdPlaying;
}

export function setIsAdPlaying(value: boolean): void {
    isAdPlaying = value;
}

export function getIsLivePremiere(): boolean {
    return isLivePremiere;
}

export function getLastNonInlineVideoID(): VideoID | null {
    return lastNonInlineVideoID;
}

export function getIsInline(): boolean {
    return isInline;
}

export function isCurrentTimeWrong(): boolean {
    return currentTimeWrong;
}