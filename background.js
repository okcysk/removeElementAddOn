const blockedSites = [
  "xmtrading.com",
  "janitorprecisiontrio.com",
  "displayvertising.com",
  "phicippics.com",
  "perfectflowing.com",
  "aliexpress.com",
  "skinnycrawlinglax.com",
  "ja.tklivechat.com",
  "wayfarerorthodox.com",
  "matchmylovedates.com",
  "kfanredvniqervqievn.slmonsmoke-f5af2eae.southcentralus.azurecontainerapps.io",
];

const isBlocked = (url) => !!url && blockedSites.some(site => url.includes(site));

const loadJson = (file) => fetch(chrome.runtime.getURL(file)).then(res => res.json());

// JSONのルールのうち、まだ取り込んでいないものだけを保存済みのルールに追加する。
// 一度取り込んだルールは seen に記録するので、右クリックやオプション画面で消したルールが復活しない
function mergeNewDefaults(stored, defaults, seen) {
  const merged = { ...stored };
  Object.entries(defaults).forEach(([site, selectors]) => {
    selectors.forEach(selector => {
      const key = `${site}\t${selector}`;
      if (seen.includes(key)) return;
      seen.push(key);
      merged[site] = [...new Set([...(merged[site] ?? []), selector])];
    });
  });
  return merged;
}

Promise.all([
  loadJson("removeSettings.json"),
  loadJson("clickSettings.json"),
  chrome.storage.local.get(["removeRules", "clickRules", "seenRemoveDefaults", "seenClickDefaults"]),
]).then(([removeData, clickData, stored]) => {
  const seenRemoveDefaults = stored.seenRemoveDefaults ?? [];
  const seenClickDefaults = stored.seenClickDefaults ?? [];
  chrome.storage.local.set({
    removeRules: mergeNewDefaults(stored.removeRules ?? {}, removeData, seenRemoveDefaults),
    clickRules: mergeNewDefaults(stored.clickRules ?? {}, clickData, seenClickDefaults),
    seenRemoveDefaults,
    seenClickDefaults,
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ toggleState: true });
  chrome.contextMenus.removeAll(() => {
    // 右クリックした要素を選んだ状態で表示モード（＝消すモード）に入る
    chrome.contextMenus.create({
      id: "remove_element",
      title: "この要素を消す",
      contexts: ["all"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "remove_element") {
    chrome.tabs.sendMessage(tab.id, { action: "remove_clicked_element" }, { frameId: info.frameId })
      .catch(() => {});  // iframe内などコンテンツスクリプトがない場所では何もしない
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.storage.local.get("toggleState", (data) => {
    const newState = !data.toggleState;
    chrome.storage.local.set({ toggleState: newState });
    chrome.tabs.sendMessage(tab.id, { action: "toggle_visibility", state: newState })
      .catch(() => {});  // chrome:// のページや、拡張機能の再読み込み前から開いていたタブでは何もしない
  });

  if (isBlocked(tab.pendingUrl)) {
    chrome.tabs.remove(tab.id);
  }
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (isBlocked(details.url)) {
    chrome.tabs.remove(details.tabId);
  }
});
