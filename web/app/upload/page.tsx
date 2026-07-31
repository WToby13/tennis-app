"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { uploadFile } from "@/lib/uploadClient";

export default function UploadPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const { videoId } = await uploadFile(file, {
        title: title || file.name,
        onProgress: setProgress,
      });
      router.push(`/watch/${videoId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <h1>Upload a match</h1>
      <p className="muted">
        Uploaded in chunks via multipart — the same flow the iPhone recorder uses.
      </p>

      <form onSubmit={onSubmit} className="card" style={{ padding: 20, marginTop: 12 }}>
        <label className="field">
          <span className="lbl">Title</span>
          <input
            type="text"
            placeholder="e.g. Sunday singles vs. Alex"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="field">
          <span className="lbl">Video file</span>
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
        </label>

        {busy && (
          <div style={{ marginBottom: 16 }}>
            <div className="progress">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
              Uploading… {Math.round(progress * 100)}%
            </div>
          </div>
        )}

        {error && (
          <p style={{ color: "var(--danger)", fontSize: 14 }}>Upload failed: {error}</p>
        )}

        <button className="btn" type="submit" disabled={!file || busy}>
          {busy ? "Uploading…" : "Upload"}
        </button>
      </form>
    </div>
  );
}
