import { describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import { checkImageUrl, fetchImage, imageType, isPrivateAddress } from "./fetch-safe.js";
import { youtubeId } from "./changes.js";

describe("image fetch guards", () => {
  it("refuses private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "172.21.0.7", "192.168.1.228", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("142.250.80.46")).toBe(false);
  });

  it("only takes https URLs on public domain names", () => {
    expect(() => checkImageUrl("http://example.com/a.png")).toThrow("must be https");
    expect(() => checkImageUrl("https://10.0.0.1/a.png")).toThrow("not an IP address");
    expect(() => checkImageUrl("https://camberstack:3000/a.png")).toThrow("standard https port");
    expect(() => checkImageUrl("https://traefik/a.png")).toThrow("public domain");
    expect(() => checkImageUrl("https://user:pw@example.com/a.png")).toThrow("credentials");
    expect(checkImageUrl("https://example.com/a.png#x").toString()).toBe("https://example.com/a.png");
  });

  it("refuses a name that resolves to a private address at connect time", async () => {
    // The resolver is stubbed: a real lookup (of localhost.localtest.me) ran past the 5s test limit about 1 run in 5
    // while the router dropped DNS queries (infrastructure/README.md, 2026-11-18). The connect-time check is what's tested.
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) =>
      cb(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as typeof dns.lookup);
    try {
      await expect(fetchImage("https://rebind.example.com/a.png")).rejects.toThrow(/resolves to a private address/);
      expect(lookup).toHaveBeenCalledWith("rebind.example.com", expect.anything(), expect.any(Function));
    } finally { lookup.mockRestore(); }
  });

  it("knows PNG, JPEG and GIF by their bytes", () => {
    expect(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("PNG");
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("JPEG");
    expect(imageType(Buffer.from("GIF89a....."))).toBe("GIF");
    expect(imageType(Buffer.from("<html>"))).toBeNull();
  });

  it("reads YouTube ids from ids and every URL shape", () => {
    for (const u of ["dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?t=3",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ"]) expect(youtubeId(u), u).toBe("dQw4w9WgXcQ");
    expect(() => youtubeId("https://vimeo.com/1")).toThrow();
  });
});
