import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { firstHttpsUri } from "./playback.ts";
import { redactLive } from "./redact.ts";
import { liveVersions } from "./versions.ts";

export class PutioFailure extends Schema.TaggedError<PutioFailure>()(
  "PutioFailure",
  { message: Schema.String },
) {}

export const PutioFile = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  size: Schema.optional(Schema.Number),
});

export const AccountEnvelope = Schema.Struct({
  status: Schema.Literal("OK"),
  info: Schema.Struct({
    username: Schema.String,
    account_status: Schema.String,
  }),
});

export const FileEnvelope = Schema.Struct({
  status: Schema.Literal("OK"),
  file: PutioFile,
});

export const UploadEnvelope = Schema.Struct({
  status: Schema.Literal("OK"),
  file: Schema.optional(PutioFile),
  transfer: Schema.optional(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
    }),
  ),
});

export const DownloadUrlEnvelope = Schema.Struct({
  status: Schema.Literal("OK"),
  url: Schema.String,
});

export const OkEnvelope = Schema.Struct({
  status: Schema.Literal("OK"),
});

export const Subtitle = Schema.Struct({
  key: Schema.String,
  language_code: Schema.optional(Schema.NullOr(Schema.String)),
  format: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.String),
  language: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

export const SubtitlesEnvelope = Schema.Struct({
  status: Schema.optional(Schema.Literal("OK")),
  subtitles: Schema.optional(Schema.Array(Subtitle)),
});

export const StartFromEnvelope = Schema.Struct({
  status: Schema.Literal("OK"),
  start_from: Schema.Number,
});

export const Transfer = Schema.Struct({
  id: Schema.Number,
  status: Schema.String,
  file_id: Schema.optional(Schema.NullOr(Schema.Number)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  percent_done: Schema.optional(Schema.NullOr(Schema.Number)),
});

export const TransferEnvelope = Schema.Struct({
  status: Schema.optional(Schema.String),
  transfer: Schema.optional(Transfer),
  error: Schema.optional(Schema.String),
  error_type: Schema.optional(Schema.String),
  error_message: Schema.optional(Schema.String),
});

const designatedToken = Effect.fn("live.putio.token")(function* () {
  const value = process.env[liveVersions.putioTokenEnv];
  if (typeof value !== "string" || value.trim().length === 0)
    return yield* new PutioFailure({
      message: "Designated put.io token is missing",
    });
  return value.trim();
});

const request = Effect.fn("live.putio.request")(function* (
  url: string,
  init: RequestInit,
) {
  const destination = yield* Effect.try({
    try: () => new URL(url),
    catch: () => new PutioFailure({ message: "Invalid provider destination" }),
  });
  if (
    destination.username ||
    destination.password ||
    ![liveVersions.apiBase, liveVersions.uploadBase].some(
      (origin) => destination.origin === origin,
    )
  )
    return yield* new PutioFailure({
      message: "Provider authentication refused for untrusted origin",
    });
  const token = yield* designatedToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `token ${token}`);
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        ...init,
        headers,
        signal,
        redirect: "manual",
      }),
    catch: (cause) => new PutioFailure({ message: redactLive(String(cause)) }),
  });
  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new PutioFailure({ message: redactLive(String(cause)) }),
  });
  return { ok: response.ok, status: response.status, text };
});

const requestJson = Effect.fn("live.putio.requestJson")(function* (
  url: string,
  init: RequestInit,
) {
  const response = yield* request(url, init);
  if (!response.ok)
    return yield* new PutioFailure({
      message: `put.io HTTP ${response.status}`,
    });
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    return yield* new PutioFailure({
      message: "put.io returned invalid JSON",
    });
  }
});

export const accountInfo = Effect.fn("live.putio.accountInfo")(function* () {
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/account/info`,
    {},
  );
  const envelope = yield* Schema.decodeUnknownEffect(AccountEnvelope)(
    parsed,
  ).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io account response failed schema",
        }),
    ),
  );
  return envelope.info;
}, Effect.timeout("20 seconds"));

export const createFolder = Effect.fn("live.putio.createFolder")(function* (
  name: string,
) {
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/files/create-folder`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        name,
        parent_id: "0",
      }),
    },
  );
  const envelope = yield* Schema.decodeUnknownEffect(FileEnvelope)(parsed).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io create-folder response failed schema",
        }),
    ),
  );
  return envelope.file;
}, Effect.timeout("20 seconds"));

export const uploadFile = Effect.fn("live.putio.uploadFile")(function* (
  path: string,
  fileName: string,
  parentId: number,
  mediaType = "video/mp4",
) {
  const bytes = yield* Effect.tryPromise(() => readFile(path));
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: mediaType }),
    fileName,
  );
  form.append("filename", fileName);
  form.append("parent_id", String(parentId));
  const parsed = yield* requestJson(
    `${liveVersions.uploadBase}/v2/files/upload`,
    { method: "POST", body: form },
  );
  const envelope = yield* Schema.decodeUnknownEffect(UploadEnvelope)(
    parsed,
  ).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io upload response failed schema",
        }),
    ),
  );
  if (envelope.file) return envelope.file;
  return yield* new PutioFailure({
    message: "put.io upload did not return a file",
  });
}, Effect.timeout("2 minutes"));

export const downloadUrl = Effect.fn("live.putio.downloadUrl")(function* (
  fileId: number,
) {
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/files/${fileId}/url`,
    {},
  );
  const envelope = yield* Schema.decodeUnknownEffect(DownloadUrlEnvelope)(
    parsed,
  ).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io download URL response failed schema",
        }),
    ),
  );
  if (!envelope.url.startsWith("https://"))
    return yield* new PutioFailure({
      message: "put.io download URL was not HTTPS",
    });
  return envelope.url;
}, Effect.timeout("20 seconds"));

export const hlsPlaylist = Effect.fn("live.putio.hlsPlaylist")(function* (
  fileId: number,
) {
  const response = yield* request(
    `${liveVersions.apiBase}/v2/files/${fileId}/hls/media.m3u8?subtitle_languages=eng`,
    {
      headers: {
        accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
      },
    },
  );
  if (!response.ok)
    return yield* new PutioFailure({
      message: `put.io HLS HTTP ${response.status}`,
    });
  return response.text;
}, Effect.timeout("20 seconds"));

export const hlsCueText = Effect.fn("live.putio.hlsCueText")(function* (
  fileId: number,
) {
  const playlist = yield* hlsPlaylist(fileId);
  if (/WEBVTT/i.test(playlist) && !/#EXTM3U/i.test(playlist)) return playlist;
  const uri = firstHttpsUri(playlist);
  if (!uri)
    return yield* new PutioFailure({
      message: "HLS playlist had no subtitle URI",
    });
  const anonymous = yield* Effect.tryPromise({
    try: (signal) => fetch(uri, { signal }),
    catch: () => new PutioFailure({ message: "HLS subtitle fetch failed" }),
  }).pipe(Effect.catch(() => Effect.succeed<Response | undefined>(undefined)));
  if (anonymous?.ok) {
    const body = yield* Effect.tryPromise({
      try: () => anonymous.text(),
      catch: () =>
        new PutioFailure({
          message: "HLS subtitle body could not be read",
        }),
    });
    if (body.trim().length > 0) return body;
  }
  const retry = yield* request(uri, {});
  if (!retry.ok || retry.text.trim().length === 0)
    return yield* new PutioFailure({
      message: `HLS subtitle HTTP ${retry.status || anonymous?.status || 0}`,
    });
  return retry.text;
}, Effect.timeout("20 seconds"));

export const listSubtitles = Effect.fn("live.putio.listSubtitles")(function* (
  fileId: number,
  languages: readonly string[] = ["eng", "en"],
) {
  const query = languages.length
    ? `?languages=${encodeURIComponent(languages.join(","))}`
    : "";
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/files/${fileId}/subtitles${query}`,
    {},
  );
  const envelope = yield* Schema.decodeUnknownEffect(SubtitlesEnvelope)(
    parsed,
  ).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io subtitles response failed schema",
        }),
    ),
  );
  return envelope.subtitles ?? [];
}, Effect.timeout("20 seconds"));

export const downloadSubtitle = Effect.fn("live.putio.downloadSubtitle")(
  function* (fileId: number, key: string) {
    const response = yield* request(
      `${liveVersions.apiBase}/v2/files/${fileId}/subtitles/${encodeURIComponent(key)}`,
      {},
    );
    if (!response.ok)
      return yield* new PutioFailure({
        message: `put.io subtitle HTTP ${response.status}`,
      });
    if (response.text.trim().length === 0)
      return yield* new PutioFailure({
        message: "put.io subtitle download was empty",
      });
    return response.text;
  },
  Effect.timeout("20 seconds"),
);

export const setStartFrom = Effect.fn("live.putio.setStartFrom")(function* (
  fileId: number,
  time: number,
) {
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/files/${fileId}/start-from`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ time: String(time) }),
    },
  );
  yield* Schema.decodeUnknownEffect(OkEnvelope)(parsed).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io start-from set response failed schema",
        }),
    ),
  );
}, Effect.timeout("20 seconds"));

export const getStartFrom = Effect.fn("live.putio.getStartFrom")(function* (
  fileId: number,
) {
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/files/${fileId}/start-from`,
    {},
  );
  const envelope = yield* Schema.decodeUnknownEffect(StartFromEnvelope)(
    parsed,
  ).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io start-from get response failed schema",
        }),
    ),
  );
  return envelope.start_from;
}, Effect.timeout("20 seconds"));

export const resetStartFrom = Effect.fn("live.putio.resetStartFrom")(function* (
  fileId: number,
) {
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/files/${fileId}/start-from/delete`,
    { method: "POST" },
  );
  yield* Schema.decodeUnknownEffect(OkEnvelope)(parsed).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io start-from delete response failed schema",
        }),
    ),
  );
}, Effect.timeout("20 seconds"));

export const addTransfer = Effect.fn("live.putio.addTransfer")(function* (
  url: string,
  parentId: number,
) {
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/transfers/add`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        url,
        save_parent_id: String(parentId),
      }),
    },
  );
  const envelope = yield* Schema.decodeUnknownEffect(TransferEnvelope)(
    parsed,
  ).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io transfer add response failed schema",
        }),
    ),
  );
  if (envelope.status !== "OK" || envelope.transfer === undefined)
    return yield* new PutioFailure({
      message: redactLive(
        envelope.error_message ??
          envelope.error ??
          envelope.error_type ??
          `transfer add status ${envelope.status ?? "missing"}`,
      ),
    });
  return envelope.transfer;
}, Effect.timeout("20 seconds"));

export const getTransfer = Effect.fn("live.putio.getTransfer")(function* (
  id: number,
) {
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/transfers/${id}`,
    {},
  );
  const envelope = yield* Schema.decodeUnknownEffect(TransferEnvelope)(
    parsed,
  ).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io transfer get response failed schema",
        }),
    ),
  );
  if (envelope.transfer === undefined)
    return yield* new PutioFailure({
      message: "put.io transfer get had no transfer",
    });
  return envelope.transfer;
}, Effect.timeout("20 seconds"));

export const cancelTransfers = Effect.fn("live.putio.cancelTransfers")(
  function* (ids: readonly number[]) {
    if (ids.length === 0) return;
    const parsed = yield* requestJson(
      `${liveVersions.apiBase}/v2/transfers/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          transfer_ids: ids.join(","),
        }),
      },
    );
    yield* Schema.decodeUnknownEffect(OkEnvelope)(parsed).pipe(
      Effect.mapError(
        () =>
          new PutioFailure({
            message: "put.io transfer cancel response failed schema",
          }),
      ),
    );
  },
  Effect.timeout("20 seconds"),
);

export const waitForTransfer = Effect.fn("live.putio.waitForTransfer")(
  function* (id: number) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const transfer = yield* getTransfer(id);
      if (transfer.status === "COMPLETED") return transfer;
      if (transfer.status === "ERROR")
        return yield* new PutioFailure({
          message: "put.io transfer ended in ERROR",
        });
      yield* Effect.sleep("2 seconds");
    }
    return yield* new PutioFailure({
      message: "put.io transfer did not complete before the poll deadline",
    });
  },
  Effect.timeout("90 seconds"),
);

export const deleteFiles = Effect.fn("live.putio.deleteFiles")(function* (
  ids: readonly number[],
) {
  if (ids.length === 0) return;
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/files/delete?skip_trash=true&skip_nonexistents=true`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        file_ids: ids.join(","),
      }),
    },
  );
  yield* Schema.decodeUnknownEffect(OkEnvelope)(parsed).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io delete response failed schema",
        }),
    ),
  );
}, Effect.timeout("20 seconds"));
