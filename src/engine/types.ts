import type { DownloadTask } from "./DownloadTask";

export type DownloadStatus =
  | "queued"
  | "connecting"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export interface DownloadInit {
  /** Stable unique id, caller-supplied (e.g. crypto.randomUUID()). */
  id: string;
  url: string;
  /** Absolute path the finished file should end up at. */
  destinationPath: string;
  /** Extra request headers (Cookie, Referer, User-Agent...) for authenticated downloads. */
  headers?: Record<string, string>;
  /** Max parallel connections for this one file. Default 16. */
  maxConnections?: number;
  /** Minimum bytes per connection; also the threshold below which we don't split. Default 1 MiB. */
  minSizeToSegment?: number;
  /** A connection's remaining work must be at least 2x this before an idle connection steals half. Default 128 KiB. */
  minStealBytes?: number;
  /** Base backoff delay (ms) between retries of a dropped connection. Default 1000. Mainly for tests. */
  retryBaseDelayMs?: number;
  /** True if the user/browser chose the file name, so the server's Content-Disposition must not rename it. */
  nameIsFinal?: boolean;
  /** Provided by the manager: returns a path that collides with no other download or existing file. */
  reservePath?: (desired: string, self: DownloadTask) => string;
}

export interface SegmentState {
  index: number;
  /** Inclusive byte offsets into the destination file. */
  start: number;
  /** Null means "until the server ends the response" (total size unknown). May shrink when a segment is split. */
  end: number | null;
  /** Bytes written to disk so far for this segment (contiguous from `start`). */
  received: number;
  done: boolean;
  /** Runtime only: bytes received but still in the write buffer. Never persisted. */
  buffered?: number;
}

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number | null;
  percent: number | null;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  /** Connections actively transferring right now. */
  connections: number;
}

export interface SerializedDownload {
  id: string;
  url: string;
  destinationPath: string;
  headers?: Record<string, string>;
  maxConnections?: number;
  /** Legacy (v0.1) name for maxConnections. */
  maxSegments?: number;
  status: DownloadStatus;
  /** True if the download was running (not user-paused) when state was saved. */
  resumeOnLaunch?: boolean;
  totalBytes: number | null;
  acceptsRanges: boolean;
  nameLocked?: boolean;
  /** Validators from the first response, sent as If-Range so a changed file is never stitched together with an old one. */
  etag?: string;
  lastModified?: string;
  /** Whether the last failure was transient (network drop, 5xx) and worth retrying automatically. */
  retryable?: boolean;
  segmentStates: Array<Pick<SegmentState, "index" | "start" | "end" | "received" | "done">>;
  error?: string;
  createdAt: number;
}

/**
 * Deliberately not named "error": Node's EventEmitter special-cases that exact
 * string and throws when no listener is attached.
 */
export interface DownloadEvents {
  progress: (progress: DownloadProgress) => void;
  status: (status: DownloadStatus) => void;
  failed: (message: string) => void;
  completed: () => void;
}
