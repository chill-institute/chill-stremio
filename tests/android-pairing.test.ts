import { test, expect } from "vite-plus/test";
import { pairingChallenge } from "../harness/native/android-pairing.ts";

const wall = '<node text="Link Account" />';
test("pairing requires a login wall and exactly one challenge", () => {
  expect(pairingChallenge('<node text="AB12" />')).toBeUndefined();
  expect(pairingChallenge(`${wall}<node text="AB12" />`)).toBe("AB12");
  expect(
    pairingChallenge(`${wall}<node text="AB12" /><node text="CD34" />`),
  ).toBeUndefined();
});
test("official link wins over unrelated four-character UI labels", () => {
  expect(
    pairingChallenge(
      `${wall}<node text="https://link.stremio.com/ab12" /><node text="HOME" />`,
    ),
  ).toBe("AB12");
  expect(
    pairingChallenge(`${wall}<node text="https://elsewhere.example/AB12" />`),
  ).toBeUndefined();
});
