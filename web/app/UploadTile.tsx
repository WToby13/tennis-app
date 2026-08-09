"use client";

import { useCallback, useRef, useState } from "react";
import { UploadIcon } from "./icons";
import { uploadFile } from "@/lib/uploadClient";

/**
 * Inline upload, sitting as the first cell of the match grid — uploading a match
 * belongs where the matches are, not on a page of its own.
 *
 * The title defaults to the file name; renaming is already possible from the
 * watch page, so asking for one up front only slows the common case down.
 */
export function UploadTile({ onUploaded }: { onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragover, setDragover] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const start = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setProgress(0);
      setName(file.name);
      try {
        await uploadFile(file, { title: file.name, onProgress: setProgress });
        onUploaded();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onUploaded],
  );

  if (busy) {
    return (
      <div className="upload-tile busy">
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          Uploading {name}
        </div>
        <div className="progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
          {Math.round(progress * 100)}%
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`upload-tile ${dragover ? "dragover" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragover(true);
        }}
        onDragLeave={() => setDragover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragover(false);
          const file = e.dataTransfer.files?.[0];
          if (file) start(file);
        }}
      >
        <UploadIcon size={26} />
        <span style={{ fontWeight: 600 }}>Upload a match</span>
        <span style={{ fontSize: 13 }}>Drop a video here, or click to choose one</span>
        {error && (
          <span style={{ fontSize: 12, color: "var(--danger)" }}>Upload failed: {error}</span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) start(file);
          e.target.value = ""; // let the same file be picked again after a failure
        }}
      />
    </>
  );
}
