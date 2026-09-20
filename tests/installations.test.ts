import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { InstallationStore } from "../src/installations.ts";

async function fixture(run: (file: string, key: Buffer) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "installations-"));
  try {
    await run(join(dir, "state.sqlite"), randomBytes(32));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const input = {
  owner: "user-1",
  token: "fake-chill-bearer",
  folderId: "9223372036854775807",
};

test("installations survive restart with encrypted credentials and enforce ownership", async () => {
  await fixture(async (file, key) => {
    const first = await InstallationStore.open(file, key);
    const installation = first.create(input);
    assert.equal(first.list("user-2").length, 0);
    assert.equal(first.revoke("user-2", installation.id), false);
    assert.deepEqual(first.resolve(installation.capability), installation);
    for (const name of await readdir(join(file, ".."))) {
      const data = await readFile(join(file, "..", name));
      assert.equal(data.includes(input.token), false);
      assert.equal(data.includes(installation.capability), false);
    }
    first.close();
    const reopened = await InstallationStore.open(file, key);
    assert.deepEqual(reopened.list(input.owner), [installation]);
    assert.equal(reopened.revoke(input.owner, installation.id), true);
    assert.equal(reopened.resolve(installation.capability), undefined);
    reopened.close();
  });
});

test("wrong encryption key fails closed without disclosing stored secrets", async () => {
  await fixture(async (file, key) => {
    const store = await InstallationStore.open(file, key);
    const installation = store.create(input);
    store.close();
    await assert.rejects(InstallationStore.open(file, randomBytes(32)), {
      message: "storage_unavailable",
    });
    const recovered = await InstallationStore.open(file, key);
    assert.ok(recovered.resolve(installation.capability));
    recovered.close();
  });
});

test("installation quota remains transactional across connections and malformed input is rejected", async () => {
  await fixture(async (file, key) => {
    const one = await InstallationStore.open(file, key);
    const two = await InstallationStore.open(file, key);
    for (let i = 0; i < 10; i++) one.create(input);
    assert.throws(() => two.create(input), { message: "resource_exhausted" });
    assert.equal(two.list(input.owner).length, 10);
    assert.ok(two.create({ ...input, owner: "other" }));
    assert.throws(
      () => two.create({ ...input, folderId: "9223372036854775808" }),
      { message: "invalid_request" },
    );
    assert.throws(
      () => two.create({ ...input, token: "header\r\ninjection" }),
      { message: "invalid_request" },
    );
    assert.equal(two.resolve("malformed"), undefined);
    one.close();
    two.close();
    assert.throws(() => two.create(input), { message: "storage_unavailable" });
  });
});

test("storage refuses symlinks and permissive files or directories", async () => {
  await fixture(async (file, key) => {
    const store = await InstallationStore.open(file, key);
    store.close();
    const link = `${file}.link`;
    await symlink(file, link);
    await assert.rejects(InstallationStore.open(link, key), {
      message: "storage_unavailable",
    });
    await chmod(file, 0o644);
    await assert.rejects(InstallationStore.open(file, key), {
      message: "storage_unavailable",
    });
    await chmod(file, 0o600);
    await chmod(join(file, ".."), 0o755);
    await assert.rejects(InstallationStore.open(file, key), {
      message: "storage_unavailable",
    });
  });
});

test("acquisition claims survive lost responses, restarts and new installations without duplicate submission", async () => {
  await fixture(async (file, key) => {
    const first = await InstallationStore.open(file, key);
    const install = first.create(input);
    const claim = first.claim(install.id, "chill:movie:MQ", "release-1");
    assert.equal(claim.fresh, true);
    assert.equal(claim.operation.state, "unknown");
    first.close();
    const next = await InstallationStore.open(file, key);
    assert.deepEqual(next.claim(install.id, "chill:movie:MQ", "release-1"), {
      fresh: false,
      operation: claim.operation,
    });
    next.revoke(input.owner, install.id);
    const replacement = next.create(input);
    assert.equal(
      next.claim(replacement.id, "chill:movie:MQ", "release-1").fresh,
      false,
    );
    next.submitted(replacement.id, claim.operation.id, "912");
    assert.equal(next.operations(replacement.id)[0]?.transferId, "912");
    const other = next.create({ ...input, owner: "user-2" });
    assert.deepEqual(next.operations(other.id), []);
    assert.throws(() => next.submitted(other.id, claim.operation.id, "913"), {
      message: "storage_unavailable",
    });
    assert.equal(
      next.claim(other.id, "chill:movie:MQ", "release-1").fresh,
      true,
    );
    next.close();
  });
});

test("version one migration preserves installation and duplicate prevention before adding download titles", async () => {
  await fixture(async (file, key) => {
    const initial = await InstallationStore.open(file, key);
    const install = initial.create(input);
    const claim = initial.claim(install.id, "chill:movie:MQ", "release-1");
    initial.close();
    const legacy = new DatabaseSync(file);
    legacy.exec(
      "ALTER TABLE acquisitions DROP COLUMN title; PRAGMA user_version=1",
    );
    legacy.close();
    await assert.rejects(InstallationStore.open(file, randomBytes(32)));
    const unchanged = new DatabaseSync(file);
    assert.equal(
      unchanged.prepare("PRAGMA user_version").get()?.user_version,
      1,
    );
    unchanged.close();
    const migrated = await InstallationStore.open(file, key);
    try {
      assert.deepEqual(migrated.resolve(install.capability), install);
      const retained = migrated.claim(
        install.id,
        "chill:movie:MQ",
        "release-1",
        "New title",
      );
      assert.equal(retained.fresh, false);
      assert.equal(retained.operation.id, claim.operation.id);
      assert.equal(retained.operation.state, "unknown");
      assert.equal(retained.operation.title, "Download");
      assert.equal(
        migrated.claim(
          install.id,
          "chill:movie:Mg",
          "release-2",
          "Selected release",
        ).operation.title,
        "Selected release",
      );
    } finally {
      migrated.close();
    }
  });
});
