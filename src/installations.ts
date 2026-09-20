import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";

const Identifier = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
);
const Owner = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Token = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[A-Za-z0-9._~+/-]+=*$/),
);
const Capability = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
const Folder = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,18})$/),
  Schema.makeFilter((value) => BigInt(value) <= 9223372036854775807n),
);
const Secrets = Schema.Struct({ token: Token, capability: Capability });
const Row = Schema.Struct({
  id: Identifier,
  owner_hash: Schema.String,
  capability_hash: Schema.String,
  folder_id: Folder,
  sealed: Schema.String,
  created_at: Schema.Int,
});
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class InstallationFailure extends Error {
  readonly code:
    | "invalid_request"
    | "resource_exhausted"
    | "storage_unavailable";
  constructor(code: InstallationFailure["code"]) {
    super(code);
    this.code = code;
  }
}
export interface Installation {
  id: string;
  folderId: string;
  createdAt: number;
  capability: string;
  token: string;
}

export class InstallationStore {
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  private constructor(db: DatabaseSync, key: Buffer) {
    this.#db = db;
    this.#key = Buffer.from(key);
  }

  static async open(file: string, key: Buffer) {
    if (key.length !== 32) throw new InstallationFailure("invalid_request");
    let db: DatabaseSync | undefined;
    try {
      const directory = dirname(file);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const parent = await lstat(directory);
      if (
        !parent.isDirectory() ||
        (parent.mode & 0o077) !== 0 ||
        parent.uid !== process.getuid?.()
      )
        throw new Error("Private storage required");
      const handle = await open(
        file,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stats = await handle.stat();
        if (
          !stats.isFile() ||
          (stats.mode & 0o077) !== 0 ||
          stats.uid !== process.getuid?.()
        )
          throw new Error("Private database required");
      } finally {
        await handle.close();
      }
      db = new DatabaseSync(file, { timeout: 2000 });
      const version = Schema.decodeUnknownSync(
        Schema.Struct({ user_version: Schema.Int }),
      )(db.prepare("PRAGMA user_version").get()).user_version;
      if (version !== 0 && version !== 1 && version !== 2)
        throw new Error("Unsupported storage version");
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS installations (
          id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, capability_hash TEXT UNIQUE NOT NULL,
          folder_id TEXT NOT NULL, sealed TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS installations_owner ON installations(owner_hash);
        CREATE TABLE IF NOT EXISTS acquisitions (
          id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, target TEXT NOT NULL,
          release_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
          transfer_id TEXT, created_at INTEGER NOT NULL,
          UNIQUE(owner_hash, fingerprint)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS acquisitions_owner ON acquisitions(owner_hash);
        CREATE TABLE IF NOT EXISTS storage_metadata (id INTEGER PRIMARY KEY CHECK(id = 1), key_check TEXT NOT NULL) STRICT;
        `);
      const keyCheck = createHmac("sha256", key)
        .update("chill-installation-store-v1")
        .digest("hex");
      const existing = db
        .prepare("SELECT key_check FROM storage_metadata WHERE id = 1")
        .get();
      if (existing) {
        const stored = Schema.decodeUnknownSync(
          Schema.Struct({
            key_check: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          }),
        )(existing).key_check;
        if (!timingSafeEqual(Buffer.from(stored), Buffer.from(keyCheck)))
          throw new Error("Invalid storage key");
      } else {
        const store = new InstallationStore(db, key);
        const first = db.prepare("SELECT * FROM installations LIMIT 1").get();
        try {
          if (first) store.#read(first);
        } finally {
          store.#key.fill(0);
        }
        db.prepare("INSERT INTO storage_metadata VALUES (1, ?)").run(keyCheck);
      }
      if (
        !db
          .prepare("PRAGMA table_info(acquisitions)")
          .all()
          .some((column) => column.name === "title")
      )
        db.exec(
          "ALTER TABLE acquisitions ADD COLUMN title TEXT NOT NULL DEFAULT 'Download'",
        );
      db.exec("PRAGMA user_version=2");
      return new InstallationStore(db, key);
    } catch {
      try {
        db?.close();
      } catch {
        /* Preserve sanitized storage failure. */
      }
      throw new InstallationFailure("storage_unavailable");
    }
  }

  #seal(id: string, owner: string, secrets: typeof Secrets.Type) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`${id}:${owner}`));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(secrets)),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }

  #read(value: unknown): Installation {
    const row = Schema.decodeUnknownSync(Row)(value);
    const bytes = Buffer.from(row.sealed, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.setAAD(Buffer.from(`${row.id}:${row.owner_hash}`));
    const secrets = Schema.decodeUnknownSync(Secrets)(
      JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      ),
    );
    if (digest(secrets.capability) !== row.capability_hash)
      throw new Error("Invalid installation");
    return {
      id: row.id,
      folderId: row.folder_id,
      createdAt: row.created_at,
      ...secrets,
    };
  }

  create(input: {
    owner: string;
    token: string;
    folderId: string;
  }): Installation {
    let parsed: typeof input;
    try {
      parsed = Schema.decodeUnknownSync(
        Schema.Struct({ owner: Owner, token: Token, folderId: Folder }),
      )(input);
    } catch {
      throw new InstallationFailure("invalid_request");
    }
    const owner = digest(parsed.owner);
    const id = randomUUID();
    const capability = randomBytes(32).toString("base64url");
    const createdAt = Date.now();
    let started = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      started = true;
      const count = Schema.decodeUnknownSync(
        Schema.Struct({ count: Schema.Int }),
      )(
        this.#db
          .prepare(
            "SELECT count(*) AS count FROM installations WHERE owner_hash = ?",
          )
          .get(owner),
      ).count;
      if (count >= 10) throw new InstallationFailure("resource_exhausted");
      this.#db
        .prepare("INSERT INTO installations VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          id,
          owner,
          digest(capability),
          parsed.folderId,
          this.#seal(id, owner, { token: parsed.token, capability }),
          createdAt,
        );
      this.#db.exec("COMMIT");
      return {
        id,
        folderId: parsed.folderId,
        token: parsed.token,
        capability,
        createdAt,
      };
    } catch (error) {
      if (started) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          /* Preserve the original failure. */
        }
      }
      if (error instanceof InstallationFailure) throw error;
      throw new InstallationFailure("storage_unavailable");
    }
  }

  list(owner: string): Installation[] {
    try {
      const parsed = Schema.decodeUnknownSync(Owner)(owner);
      return this.#db
        .prepare(
          "SELECT * FROM installations WHERE owner_hash = ? ORDER BY created_at, id",
        )
        .all(digest(parsed))
        .map((row) => this.#read(row));
    } catch {
      throw new InstallationFailure("storage_unavailable");
    }
  }

  resolve(capability: string): Installation | undefined {
    if (!Schema.is(Capability)(capability)) return undefined;
    try {
      const row = this.#db
        .prepare("SELECT * FROM installations WHERE capability_hash = ?")
        .get(digest(capability));
      return row ? this.#read(row) : undefined;
    } catch {
      throw new InstallationFailure("storage_unavailable");
    }
  }

  revoke(owner: string, id: string): boolean {
    if (!Schema.is(Identifier)(id) || !Schema.is(Owner)(owner)) return false;
    try {
      return (
        this.#db
          .prepare("DELETE FROM installations WHERE owner_hash = ? AND id = ?")
          .run(digest(owner), id).changes === 1
      );
    } catch {
      throw new InstallationFailure("storage_unavailable");
    }
  }

  #operation(value: unknown): Acquisition {
    const row = Schema.decodeUnknownSync(
      Schema.Struct({
        id: Identifier,
        title: Schema.String,
        target: Schema.String,
        release_id: Schema.String,
        transfer_id: Schema.NullOr(Folder),
        created_at: Schema.Int,
      }),
    )(value);
    return {
      id: row.id,
      title: row.title,
      target: row.target,
      releaseId: row.release_id,
      state: row.transfer_id === null ? "unknown" : "submitted",
      transferId: row.transfer_id ?? undefined,
      createdAt: row.created_at,
    };
  }

  claim(
    installationId: string,
    target: string,
    releaseId: string,
    title = "Download",
  ): { fresh: boolean; operation: Acquisition } {
    if (
      !Schema.is(Identifier)(installationId) ||
      !target ||
      target.length > 1600 ||
      !releaseId ||
      releaseId.length > 512 ||
      !title ||
      title.length > 1024
    )
      throw new InstallationFailure("invalid_request");
    let started = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      started = true;
      const owner = Schema.decodeUnknownSync(
        Schema.Struct({ owner_hash: Schema.String }),
      )(
        this.#db
          .prepare("SELECT owner_hash FROM installations WHERE id = ?")
          .get(installationId),
      ).owner_hash;
      const fingerprint = digest(JSON.stringify([target, releaseId]));
      const existing = this.#db
        .prepare(
          "SELECT * FROM acquisitions WHERE owner_hash = ? AND fingerprint = ?",
        )
        .get(owner, fingerprint);
      if (existing) {
        this.#db.exec("COMMIT");
        return { fresh: false, operation: this.#operation(existing) };
      }
      const count = Schema.decodeUnknownSync(
        Schema.Struct({ count: Schema.Int }),
      )(
        this.#db
          .prepare(
            "SELECT count(*) AS count FROM acquisitions WHERE owner_hash = ?",
          )
          .get(owner),
      ).count;
      if (count >= 1000) throw new InstallationFailure("resource_exhausted");
      const operation: Acquisition = {
        id: randomUUID(),
        target,
        releaseId,
        title,
        state: "unknown",
        transferId: undefined,
        createdAt: Date.now(),
      };
      this.#db
        .prepare(
          "INSERT INTO acquisitions (id, owner_hash, target, release_id, fingerprint, transfer_id, created_at, title) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
        )
        .run(
          operation.id,
          owner,
          target,
          releaseId,
          fingerprint,
          operation.createdAt,
          title,
        );
      this.#db.exec("COMMIT");
      return { fresh: true, operation };
    } catch (error) {
      if (started) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          /* Keep the original failure. */
        }
      }
      if (error instanceof InstallationFailure) throw error;
      throw new InstallationFailure("storage_unavailable");
    }
  }

  submitted(installationId: string, operationId: string, transferId: string) {
    if (!Schema.is(Folder)(transferId) || transferId === "0")
      throw new InstallationFailure("invalid_request");
    try {
      const result = this.#db
        .prepare(`UPDATE acquisitions SET transfer_id = ? WHERE id = ? AND transfer_id IS NULL
        AND owner_hash = (SELECT owner_hash FROM installations WHERE id = ?)`)
        .run(transferId, operationId, installationId);
      if (result.changes !== 1) throw new Error("Invalid operation");
    } catch {
      throw new InstallationFailure("storage_unavailable");
    }
  }

  operations(installationId: string): Acquisition[] {
    try {
      return this.#db
        .prepare(`SELECT * FROM acquisitions WHERE owner_hash =
        (SELECT owner_hash FROM installations WHERE id = ?) ORDER BY created_at DESC, id LIMIT 1000`)
        .all(installationId)
        .map((row) => this.#operation(row));
    } catch {
      throw new InstallationFailure("storage_unavailable");
    }
  }

  close() {
    try {
      this.#db.close();
    } finally {
      this.#key.fill(0);
    }
  }
}

export interface Acquisition {
  title: string;
  id: string;
  target: string;
  releaseId: string;
  state: "unknown" | "submitted";
  transferId?: string;
  createdAt: number;
}
