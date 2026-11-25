import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enterKeyAnswer, type EnterKeyFacts } from "./enter-key";
import { __reloadEnterSendsStore, __resetEnterSendsStore, enterSendsChoice, setEnterSends } from "./enter-sends-store";

const KEY = "collie:enter-sends:v1";

beforeEach(() => __resetEnterSendsStore());
afterEach(() => __resetEnterSendsStore());

describe("the Enter-sends store", () => {
  it("holds no choice on a device that stored nothing", () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(enterSendsChoice()).toBeNull();
  });

  it("writes a choice, either way, and keeps it across a reload", () => {
    setEnterSends(true);
    expect(localStorage.getItem(KEY)).toBe("on");
    __reloadEnterSendsStore();
    expect(enterSendsChoice()).toBe("on");
    setEnterSends(false);
    expect(localStorage.getItem(KEY)).toBe("off");
    __reloadEnterSendsStore();
    expect(enterSendsChoice()).toBe("off");
  });

  it.each(["true", "1", "0", "yes", "", "{oops"])("reads a bad stored value (%j) as no choice", (bad) => {
    localStorage.setItem(KEY, bad);
    __reloadEnterSendsStore();
    expect(enterSendsChoice()).toBeNull();
  });

  it("keeps the choice in memory when storage refuses a write", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      setEnterSends(true);
      expect(enterSendsChoice()).toBe("on");
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe("the Enter-sends build default @req:COLLIE-1291-ENTER-DEFAULT @oracle:requirement", () => {
  const hardware: EnterKeyFacts = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    repeat: false,
  };

  async function loadBuildChoice(defaultValue?: "on") {
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_COLLIE_ENTER_SENDS_DEFAULT", defaultValue);
    vi.resetModules();
    const store = await import("./enter-sends-store");
    return store.enterSendsChoice();
  }

  afterEach(() => vi.unstubAllEnvs());

  it("sends on physical Enter and leaves on-screen Enter to the browser on a device without a stored choice", async () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    const choice = await loadBuildChoice("on");
    expect(enterKeyAnswer(hardware, false, choice)).toBe("send");
    expect(enterKeyAnswer({ ...hardware, code: "" }, false, choice)).toBe("default");
    expect(enterKeyAnswer(hardware, true, choice)).toBe("default");
  });

  it("keeps a device's stored off choice after an update to the local build", async () => {
    localStorage.setItem(KEY, "off");
    const choice = await loadBuildChoice("on");
    expect(choice).toBe("off");
    expect(enterKeyAnswer(hardware, false, choice)).toBe("default");
  });

  it("keeps the choice unset in an upstream production build", async () => {
    expect(await loadBuildChoice()).toBeNull();
  });
});
