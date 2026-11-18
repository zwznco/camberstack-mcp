/** `url` with Google's pageToken query parameter added, or unchanged on the first page. */
export const withPage = (url: string, token: string) => (token ? `${url}${url.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(token)}` : url);

/** Every item under `key` across a Google list call's pages, following nextPageToken. */
export async function allPages<T = any>(get: (token: string) => Promise<any>, key: string): Promise<T[]> {
  const out: T[] = [];
  let token = "";
  do {
    const r = await get(token);
    out.push(...(r[key] ?? []));
    token = r.nextPageToken ?? "";
  } while (token);
  return out;
}
