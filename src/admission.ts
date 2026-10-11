import { createHash } from "node:crypto";

export type Lease = { release(): void };
/** Which limit refused a unit: the whole process or one add-on link. */
export type Refusal = "total" | "link";

/**
 * Counts units of open work for the process and for each add-on link. Links
 * are keyed by a hash of their credential, and a link's entry is deleted when
 * its last unit is released, so the map never outgrows `total` entries.
 */
export function createAdmission(limits: { total: number; perLink: number }) {
  let used = 0;
  const links = new Map<string, number>();
  return {
    /** Links currently holding at least one unit. */
    get links() {
      return links.size;
    },
    acquire(credential?: string): Lease | Refusal {
      const key =
        credential === undefined
          ? undefined
          : createHash("sha256").update(credential).digest("base64url");
      const held = key === undefined ? 0 : (links.get(key) ?? 0);
      if (held >= limits.perLink) return "link";
      if (used >= limits.total) return "total";
      used++;
      if (key !== undefined) links.set(key, held + 1);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          used--;
          if (key === undefined) return;
          const remaining = (links.get(key) ?? 1) - 1;
          if (remaining > 0) links.set(key, remaining);
          else links.delete(key);
        },
      };
    },
  };
}
