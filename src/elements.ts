export function getYouTubeTitleNodeSelector(): string {
    // New YouTube Title, YouTube, Mobile YouTube, Invidious, YouTube videoPrimaryInfoRenderer (2021) layout
    return "#title h1, .ytd-video-primary-info-renderer.title, .slim-video-information-title, #player-container + .h-box > h1, h1.title";
}

export function getYouTubeTitleNode(): HTMLElement {
    return document.querySelector(getYouTubeTitleNodeSelector()) as HTMLElement;
}