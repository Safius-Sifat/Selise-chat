import { env } from "$env/dynamic/public";

const FALLBACK_API_BASE_URL = "https://selise.notice.fit";

const stripTrailingSlashes = (value: string): string => {
    return value.replace(/\/+$/, "");
};

const resolveApiBaseUrl = (): string => {
    const candidate = env.PUBLIC_API_BASE_URL?.trim() || FALLBACK_API_BASE_URL;

    if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
        return stripTrailingSlashes(candidate);
    }

    return stripTrailingSlashes(`https://${candidate}`);
};

export const API_BASE_URL = resolveApiBaseUrl();
