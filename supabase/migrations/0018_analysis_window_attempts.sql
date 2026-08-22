-- Comment-only: `analysis_windows` is jsonb, so the two fields windowed analysis
-- has grown since 0013 need no schema change — but the column comment was the
-- documentation for that shape, and it had gone stale.
--
--   attempt — how many times a window has been re-submitted after coming back
--             templated. A single bad window is re-run on its own rather than
--             failing the whole match, because dropping it would leave a hole
--             that throws the smoother's server alternation out of phase for
--             every game after it (web/lib/analysisRunner.ts).
--   toEnd   — send no end_time for this window; run to the end of the file.
--             The proxy's duration and the source's differ after re-encoding,
--             and the API validates against the proxy's
--             (web/lib/twelvelabs/windows.ts).

comment on column public.videos.analysis_windows is
  'Windowed analysis state: [{"startS":int,"endS":int,"taskId":text,"toEnd":bool,"attempt":int}]. Null when the match was analysed in a single call (see analysis_task_id).';
