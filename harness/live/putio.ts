import { readFile } from "node:fs/promises";
import { Effect, Option, Schema } from "effect";
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
  file_type: Schema.optional(Schema.NullOr(Schema.String)),
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
  hash: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
  magneturi: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optional(Schema.NullOr(Schema.Number)),
  save_parent_id: Schema.optional(Schema.NullOr(Schema.Number)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const Cursor = Schema.optional(Schema.NullOr(Schema.String));

export const FolderListEnvelope = Schema.Struct({
  status: Schema.Literal("OK"),
  files: Schema.Array(PutioFile),
  cursor: Cursor,
});

export const TransferListEnvelope = Schema.Struct({
  status: Schema.optional(Schema.Literal("OK")),
  transfers: Schema.Array(Transfer),
  cursor: Cursor,
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
  return {
    ok: response.ok,
    status: response.status,
    text,
    date: response.headers.get("date"),
  };
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
  parentId = 0,
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
        parent_id: String(parentId),
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

/** Whether put.io no longer has a file, read independently of its deletion. */
export const fileAbsent = Effect.fn("live.putio.fileAbsent")(function* (
  id: number,
) {
  const response = yield* request(`${liveVersions.apiBase}/v2/files/${id}`, {});
  if (response.status === 404) return true;
  if (response.ok) return false;
  return yield* new PutioFailure({
    message: `put.io HTTP ${response.status}`,
  });
}, Effect.timeout("20 seconds"));

/** One folder's entries with their names and types, from a single page. */
export const listFolder = Effect.fn("live.putio.listFolder")(function* (
  parentId: number,
) {
  const parsed = yield* requestJson(
    `${liveVersions.apiBase}/v2/files/list?parent_id=${parentId}&per_page=1000`,
    {},
  );
  const envelope = yield* Schema.decodeUnknownEffect(FolderListEnvelope)(
    parsed,
  ).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io folder list response failed schema",
        }),
    ),
  );
  if (envelope.cursor)
    return yield* new PutioFailure({
      message: "put.io folder list exceeds one page",
    });
  return envelope.files.map((file) => ({
    id: file.id,
    name: file.name,
    fileType: file.file_type ?? undefined,
  }));
}, Effect.timeout("20 seconds"));

export const listFolderIds = (parentId: number) =>
  listFolder(parentId).pipe(
    Effect.map((files) => files.map((file) => file.id)),
  );

/** Every transfer on the account, up to five pages of 1000. */
export const listTransfers = Effect.fn("live.putio.listTransfers")(
  function* () {
    const transfers: (typeof Transfer.Type)[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const parsed = yield* requestJson(
        cursor === undefined
          ? `${liveVersions.apiBase}/v2/transfers/list?per_page=1000`
          : `${liveVersions.apiBase}/v2/transfers/list/continue?per_page=1000`,
        cursor === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ cursor }),
            },
      );
      const envelope = yield* Schema.decodeUnknownEffect(TransferListEnvelope)(
        parsed,
      ).pipe(
        Effect.mapError(
          () =>
            new PutioFailure({
              message: "put.io transfer list response failed schema",
            }),
        ),
      );
      transfers.push(...envelope.transfers);
      if (!envelope.cursor) return transfers;
      cursor = envelope.cursor;
    }
    return yield* new PutioFailure({
      message: "put.io transfer list exceeds the page limit",
    });
  },
  Effect.timeout("60 seconds"),
);

export const SearchEnvelope = Schema.Struct({
  status: Schema.Literal("OK"),
  files: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  cursor: Cursor,
  total: Schema.optional(Schema.Number),
});

const ErrorType = Schema.Struct({ error_type: Schema.String });

export type SearchPage =
  | {
      ok: true;
      files: readonly Record<string, unknown>[];
      cursor: boolean;
      total?: number;
    }
  | { ok: false; httpStatus: number; errorType?: string };

/** One search page; HTTP 400 is returned as a refused query, not a failure. */
export const searchFiles = Effect.fn("live.putio.searchFiles")(function* (
  query: string,
) {
  const url = new URL("/v2/files/search", liveVersions.apiBase);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "100");
  const response = yield* request(url.href, {});
  if (response.status === 400) {
    const refusal = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.fromJsonString(ErrorType))(
        response.text,
      ),
    );
    return {
      ok: false,
      httpStatus: 400,
      errorType: refusal?.error_type,
    } satisfies SearchPage;
  }
  if (!response.ok)
    return yield* new PutioFailure({
      message: `put.io search HTTP ${response.status}`,
    });
  const parsed = yield* Effect.try({
    try: () => JSON.parse(response.text) as unknown,
    catch: () => new PutioFailure({ message: "put.io returned invalid JSON" }),
  });
  const envelope = yield* Schema.decodeUnknownEffect(SearchEnvelope)(
    parsed,
  ).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({
          message: "put.io search response failed schema",
        }),
    ),
  );
  return {
    ok: true,
    files: envelope.files,
    cursor: Boolean(envelope.cursor),
    total: envelope.total,
  } satisfies SearchPage;
}, Effect.timeout("20 seconds"));

export const FileDetailEnvelope = Schema.Struct({
  status: Schema.Literal("OK"),
  file: Schema.Struct({
    id: Schema.Int,
    name: Schema.optional(Schema.NullOr(Schema.String)),
    parent_id: Schema.optional(Schema.NullOr(Schema.Int)),
    created_at: Schema.optional(Schema.NullOr(Schema.String)),
    file_type: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

/** put.io's clock, to the second, from a read-only response's Date header. */
export const serverTime = Effect.fn("live.putio.serverTime")(function* () {
  const response = yield* request(
    `${liveVersions.apiBase}/v2/account/info`,
    {},
  );
  const time = response.date ? Date.parse(response.date) : Number.NaN;
  if (!response.ok || !Number.isFinite(time))
    return yield* new PutioFailure({
      message: `put.io clock read HTTP ${response.status}`,
    });
  return time;
}, Effect.timeout("20 seconds"));

/** A file's name, parent, creation time and type, or `undefined` once put.io answers 404. */
export const getFile = Effect.fn("live.putio.getFile")(function* (id: number) {
  const response = yield* request(`${liveVersions.apiBase}/v2/files/${id}`, {});
  if (response.status === 404) return undefined;
  if (!response.ok)
    return yield* new PutioFailure({
      message: `put.io file get HTTP ${response.status}`,
    });
  const envelope = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(FileDetailEnvelope),
  )(response.text).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({ message: "put.io file get response failed schema" }),
    ),
  );
  if (envelope.file.id !== id)
    return yield* new PutioFailure({
      message: "put.io file get returned a different file",
    });
  return {
    id,
    name: envelope.file.name ?? undefined,
    parentId: envelope.file.parent_id ?? undefined,
    createdAt: envelope.file.created_at ?? undefined,
    fileType: envelope.file.file_type ?? undefined,
  };
}, Effect.timeout("20 seconds"));

export const fileExists = Effect.fn("live.putio.fileExists")(function* (
  id: number,
) {
  const response = yield* request(`${liveVersions.apiBase}/v2/files/${id}`, {});
  if (response.status === 404) return false;
  if (!response.ok)
    return yield* new PutioFailure({
      message: `put.io file get HTTP ${response.status}`,
    });
  const parsed = yield* Effect.try({
    try: () => JSON.parse(response.text) as unknown,
    catch: () => new PutioFailure({ message: "put.io returned invalid JSON" }),
  });
  const envelope = yield* Schema.decodeUnknownEffect(FileEnvelope)(parsed).pipe(
    Effect.mapError(
      () =>
        new PutioFailure({ message: "put.io file get response failed schema" }),
    ),
  );
  if (envelope.file.id !== id)
    return yield* new PutioFailure({
      message: "put.io file get returned a different file",
    });
  return true;
}, Effect.timeout("20 seconds"));
