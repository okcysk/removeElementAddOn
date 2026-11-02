const input = document.getElementById("removeSettingsInput");

// 設定の読み込み
chrome.storage.local.get("removeRules", (data) => {
  if (data?.removeRules) {
    input.value = JSON.stringify(data.removeRules, null, 2);
  }
});

// 設定の保存
document.getElementById("saveButton").addEventListener("click", () => {
  let settings;
  try {
    settings = JSON.parse(input.value);  // ユーザーが入力したJSONをパース
  } catch (e) {
    alert("Invalid JSON format. Please check the input.");
    return;
  }
  chrome.storage.local.set({ removeRules: settings }, () => {
    alert("Settings saved successfully!");
  });
});
