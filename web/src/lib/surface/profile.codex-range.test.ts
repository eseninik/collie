import { describe, expect, it } from "vitest";

import ledgerJson from "../harness/verified-versions.json";
import { loadProfiles, profileFor, resetProfileLog } from "./profile";

describe("the Codex range", () => {
  const row = ledgerJson.agents.codex;

  it("@oracle:requirement @req:A1 codex: the captured 0.169.0 screens extend the verified range", () => {
    const codex = loadProfiles().get("codex")!;
    const verified = codex.versions.filter((range) => range.status === "verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]!.range).toBe("0.150.0 - 0.169.0");
    expect(verified[0]!.verifiedThrough).toBe("0.169.0");
    expect(verified[0]!.verifiedOn).toBe("2026-11-14");
    expect(codex.probe.note).toContain("0.150.0, 0.159.2 and 0.163.0");
    for (const version of ["0.150.0", row.version, "0.169.0"]) {
      resetProfileLog();
      expect(profileFor("codex", version, { log: () => {} })?.status, version).toBe("verified");
    }
  });

  it("codex: the ledger's canary row sits inside the range, and a version above it is provisional", () => {
    resetProfileLog();
    expect(profileFor("codex", row.version, { log: () => {} })?.range?.range).toBe("0.150.0 - 0.169.0");
    expect(profileFor("codex", "0.170.0", { log: () => {} })?.status).toBe("provisional");
  });
});
