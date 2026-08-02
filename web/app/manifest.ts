import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tennis Reel",
    short_name: "Tennis Reel",
    description: "Record, review and share your tennis matches.",
    start_url: "/",
    display: "standalone",
    background_color: "#fbf7f0",
    theme_color: "#d9662c",
    icons: [
      { src: "/logo.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };
}
