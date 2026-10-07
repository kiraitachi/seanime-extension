/// <reference path="../_external/.onlinestream-provider.d.ts" />
/// <reference path="../_external/core.d.ts" />

// ---------- Constants ----------
const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SUBTITLE_LANGS: Record<string, string> = {
    en: "English", es: "Spanish", de: "German", fr: "French",
    id: "Indonesian", pl: "Polish", pt: "Portuguese", tr: "Turkish",
    ru: "Russian", it: "Italian", ar: "Arabic", nl: "Dutch",
    zh: "Chinese", ko: "Korean", ja: "Japanese", hu: "Hungarian",
    cs: "Czech", vi: "Vietnamese", ro: "Romanian", sv: "Swedish",
    th: "Thai", da: "Danish", he: "Hebrew", el: "Greek",
    fi: "Finnish", uk: "Ukrainian",
};

// ---------- Utility Functions ----------
function cleanTitle(title: string): string {
    return title
        .replace(/\s+/g, " ")
        .replace(/\b(And|and)\b/g, "&")
        .trim();
}

function extractSlugFromUrl(url: string): string {
    const match = url.match(/\/watch\/([^\/?#]+)/);
    return match ? match[1] : "";
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/&/g, " ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function normalizeText(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Titles on listing pages come with rating/views glued on, e.g. "Harem Camp! 4.0 12.7M"
function stripListingNoise(title: string): string {
    return title
        .replace(/\s+/g, " ")
        .replace(/\s+\d(\.\d)?\s+(Uncensored\s+)?[\d.]+[KM]?$/i, "")
        .replace(/\s*-?\s*Episode\s*\d+\s*$/i, "")
        .trim();
}

function isChallengePage(html: string): boolean {
    return (
        !html ||
        html.length < 3000 ||
        html.includes("cf-challenge") ||
        html.includes("Checking your browser") ||
        html.includes("Just a moment...")
    );
}

function absoluteUrl(base: string, href: string): string {
    if (href.startsWith("http")) return href;
    if (href.startsWith("//")) return "https:" + href;
    return base + (href.startsWith("/") ? "" : "/") + href;
}

function stripQueryAndHash(url: string): string {
    return url.split("#")[0].split("?")[0];
}

// ---------- Main Class ----------
class Provider {
    private readonly BASE_URL = "https://hentaihaven.xxx";

    getSettings(): Settings {
        return {
            episodeServers: ["HentaiHaven"],
            supportsDub: false,
        };
    }

    // ----- Networking helpers -----

    private get baseHeaders(): Record<string, string> {
        return {
            "User-Agent": UA,
            "Referer": `${this.BASE_URL}/`,
            "Origin": this.BASE_URL,
        };
    }

    /**
     * Plain fetch first; falls back to a real browser if Cloudflare (or an empty
     * response) gets in the way. `mustContain` lets callers declare that a page is
     * only considered valid if it holds specific content (e.g. an .m3u8 URL).
     */
    private async getHtml(
        url: string,
        opts?: { mustContain?: RegExp; browserWaitMs?: number; forceBrowser?: boolean },
    ): Promise<string> {
        let html = "";
        if (!opts?.forceBrowser) {
            try {
                const res = await fetch(url, { headers: this.baseHeaders });
                if (res.ok) html = await res.text();
            } catch (_) {
                // fall through to browser
            }

            const invalid = isChallengePage(html) || (opts?.mustContain ? !opts.mustContain.test(html) : false);
            if (!invalid) return html;
        }

        console.log(`Falling back to ChromeDP for ${url}`);
        let browser: any;
        try {
            browser = await ChromeDP.newBrowser({ timeout: 45000 });
            await browser.navigate(url);

            // Wait out a Cloudflare interstitial if there is one
            for (let i = 0; i < 10; i++) {
                const title = await browser.evaluate("document.title");
                if (title && title !== "Just a moment...") break;
                await browser.sleep(2500);
            }
            await browser.sleep(opts?.browserWaitMs ?? 3000);
            html = await browser.evaluate("document.documentElement.outerHTML");
        } catch (e) {
            console.log(`ChromeDP failed for ${url}: ${e}`);
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) { }
            }
        }
        return html || "";
    }

    // ----- Search -----

    /** Pull every /watch/<slug>/ title link out of a page (excludes episode pages). */
    private async parseTitleLinks(html: string): Promise<SearchResult[]> {
        const $ = await LoadDoc(html);
        const bySlug = new Map<string, SearchResult>();

        const anchors = $("a[href*='/watch/']");
        anchors.each((_, el) => {
            const href = el.attr("href") || "";
            if (!href || href.includes("/episode-")) return;

            const fullUrl = stripQueryAndHash(absoluteUrl(this.BASE_URL, href));
            const slug = extractSlugFromUrl(fullUrl);
            if (!slug) return;

            // Prefer an explicit title/alt, otherwise anchor text with the noise stripped
            let rawTitle = el.attr("title") || "";
            if (!rawTitle) {
                const img = el.find("img");
                if (img.length() > 0) rawTitle = img.attr("alt") || "";
            }
            if (!rawTitle) rawTitle = el.text().trim();

            const title = stripListingNoise(rawTitle);
            if (!title) return;

            // The listing renders two anchors per card (image + text); keep the shortest clean one
            const existing = bySlug.get(slug);
            if (!existing || title.length < existing.title.length) {
                bySlug.set(slug, {
                    id: slug,
                    title,
                    url: fullUrl.endsWith("/") ? fullUrl : fullUrl + "/",
                    subOrDub: "sub",
                });
            }
        });

        return Array.from(bySlug.values());
    }

    /** Keep only results that plausibly match the query (guards against homepage junk). */
    private filterRelevant(results: SearchResult[], query: string): SearchResult[] {
        const tokens = query
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length >= 3);
        if (tokens.length === 0) return results;

        const needed = Math.ceil(tokens.length / 2);
        return results.filter((r) => {
            const hay = normalizeText(r.title + " " + r.id);
            const hits = tokens.filter((t) => hay.includes(t)).length;
            return hits >= needed;
        });
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = cleanTitle(opts.query);
        const enc = encodeURIComponent(query);
        console.log(`Searching for: "${query}"`);

        // The old `/?s=` endpoint is gone. Current search endpoint (confirmed from the site UI):
        //   https://hentaihaven.xxx/search/?q=<query>
        const searchUrl = `${this.BASE_URL}/search/?q=${enc}`;
        console.log(`Search URL: ${searchUrl}`);

        const found = new Map<string, SearchResult>();

        // 1) Plain fetch (server-rendered results)
        try {
            const res = await fetch(searchUrl, { headers: this.baseHeaders });
            if (res.ok) {
                const html = await res.text();
                if (!isChallengePage(html)) {
                    this.filterRelevant(await this.parseTitleLinks(html), query).forEach((r) =>
                        found.set(r.id, r),
                    );
                }
            }
        } catch (_) { }

        // 2) Real browser (Cloudflare, or results rendered client-side by JS)
        if (found.size === 0) {
            const html = await this.getHtml(searchUrl, {
                forceBrowser: true,
                browserWaitMs: 5000,
            });
            if (html) {
                this.filterRelevant(await this.parseTitleLinks(html), query).forEach((r) =>
                    found.set(r.id, r),
                );
            }
        }

        // Fallback 1: direct slug guess (titles map cleanly onto slugs on this site)
        if (found.size === 0) {
            const guess = slugify(query);
            if (guess) {
                try {
                    const url = `${this.BASE_URL}/watch/${guess}/`;
                    const res = await fetch(url, { headers: this.baseHeaders });
                    if (res.ok) {
                        const html = await res.text();
                        if (!isChallengePage(html) && /\/watch\/[^"']+\/episode-\d+/.test(html)) {
                            found.set(guess, { id: guess, title: query, url, subOrDub: "sub" });
                            console.log(`Slug guess hit: ${guess}`);
                        }
                    }
                } catch (_) { }
            }
        }

        // Fallback 2: scan catalogue listing pages and filter locally
        if (found.size === 0) {
            const listings = [
                `${this.BASE_URL}/watch/?sort=latest`,
                `${this.BASE_URL}/watch/?sort=latest&page=2`,
                `${this.BASE_URL}/watch/?sort=latest&page=3`,
                `${this.BASE_URL}/browse/trending/`,
                `${this.BASE_URL}/`,
            ];
            for (const url of listings) {
                try {
                    const res = await fetch(url, { headers: this.baseHeaders });
                    if (!res.ok) continue;
                    const html = await res.text();
                    if (isChallengePage(html)) continue;
                    this.filterRelevant(await this.parseTitleLinks(html), query).forEach((r) =>
                        found.set(r.id, r),
                    );
                } catch (_) { }
            }
        }

        const results = Array.from(found.values());
        console.log(`Found ${results.length} results`);
        return results;
    }

    // ----- Episodes -----

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const url = `${this.BASE_URL}/watch/${id}/`;
        console.log(`Fetching episodes from: ${url}`);

        const episodeHrefRe = new RegExp(`/watch/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/episode-\\d+`);
        const html = await this.getHtml(url, { mustContain: episodeHrefRe });

        const $ = await LoadDoc(html);
        const episodes: EpisodeDetails[] = [];
        const seen = new Set<string>();

        $(`a[href*='/watch/${id}/episode-']`).each((_, el) => {
            const href = el.attr("href");
            if (!href) return;

            const fullUrl = stripQueryAndHash(absoluteUrl(this.BASE_URL, href));
            const normalized = fullUrl.endsWith("/") ? fullUrl : fullUrl + "/";
            if (seen.has(normalized)) return;

            const numMatch = normalized.match(/episode-(\d+)/i);
            if (!numMatch) return;
            seen.add(normalized);

            const number = parseInt(numMatch[1], 10);
            episodes.push({
                id: `${id}/episode-${number}`,
                number,
                url: normalized,
                title: `Episode ${number}`,
            });
        });

        episodes.sort((a, b) => a.number - b.number);
        console.log(`Found ${episodes.length} episodes`);
        return episodes;
    }

    // ----- Video sources -----

    private async findSubtitles(playlistUrl: string): Promise<VideoSubtitle[]> {
        const idMatch = playlistUrl.match(/octopusmanifest\.org\/([0-9a-f-]{36})\//i);
        if (!idMatch) return [];

        const manifestId = idMatch[1];
        const subs: VideoSubtitle[] = [];

        await Promise.all(
            Object.entries(SUBTITLE_LANGS).map(async ([code, name]) => {
                for (const ext of ["vtt", "ass"]) {
                    try {
                        const subUrl = `https://octopusmanifest.org/${manifestId}/s/${code}.${ext}`;
                        const res = await fetch(subUrl, { method: "HEAD", headers: this.baseHeaders });
                        if (res.ok) {
                            subs.push({
                                id: code,
                                url: subUrl,
                                language: name,
                                isDefault: code === "en",
                            });
                            return; // prefer VTT, only fall back to ASS if VTT is missing
                        }
                    } catch (_) { }
                }
            }),
        );

        // Put English first so players pick it by default
        subs.sort((a, b) => (a.id === "en" ? -1 : b.id === "en" ? 1 : a.language.localeCompare(b.language)));
        console.log(`Found ${subs.length} subtitles for ${manifestId}`);
        return subs;
    }

    private extractPlaylistUrls(html: string): string[] {
        // The URL can be escaped inside script/JSON payloads (\u002F or \/)
        const normalized = html.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
        const urls = new Set<string>();

        for (const m of normalized.matchAll(/https?:\/\/[^"'\s<>\\]+?\.m3u8[^"'\s<>\\]*/gi)) {
            urls.add(m[0].replace(/&amp;/g, "&"));
        }
        return Array.from(urls);
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const headers = this.baseHeaders;

        if (!server || server !== "HentaiHaven") {
            return { server: "", headers: {}, videoSources: [] };
        }

        console.log(`Fetching video sources for episode: ${episode.url}`);

        const videoSources: VideoSource[] = [];

        try {
            // The episode page now embeds the HLS playlist directly (no iframe/token/api.php).
            const html = await this.getHtml(episode.url, { mustContain: /\.m3u8/i });
            const playlists = this.extractPlaylistUrls(html);

            if (playlists.length === 0) {
                console.log("No .m3u8 found in episode page");
            }

            let subtitles: VideoSubtitle[] | null = null;
            for (const url of playlists) {
                if (subtitles === null) subtitles = await this.findSubtitles(url);

                videoSources.push({
                    url,
                    type: "m3u8",
                    quality: "auto",
                    subtitles: [...subtitles],
                });
            }
            console.log(`Found ${videoSources.length} sources`);
        } catch (e: any) {
            console.log(`findEpisodeServer error: ${e?.message ?? e}`);
        }

        return {
            server: "HentaiHaven",
            headers,
            videoSources,
        };
    }
}
