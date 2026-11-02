document.documentElement.style.overflowY = "scroll";
document.body && (document.body.style.overflowY = "scroll");

const currentURL = window.location.href;
let observer = null;
let displayMode = false;  // 表示モード（＝消すモード）中か
let removeMode = null;    // 表示モードのパネル（createRemoveMode の戻り値）

// 拡張機能を再読み込み・更新すると、すでに開いていたページに残った古いスクリプトからは
// chrome API が使えなくなる（"Extension context invalidated"）。そのときは何もせず後片付けする
function isExtensionAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch (e) {
    return false;
  }
}

function shutdown() {
  observer?.disconnect();
  displayMode = false;  // パネルを閉じたときに storage へ書き込まないようにする
  removeMode?.close();
}

const storage = {
  get(keys, callback) {
    if (!isExtensionAlive()) return shutdown();
    try {
      chrome.storage.local.get(keys, callback);
    } catch (e) {
      shutdown();
    }
  },
  set(items) {
    if (!isExtensionAlive()) return shutdown();
    try {
      chrome.storage.local.set(items);
    } catch (e) {
      shutdown();
    }
  },
};

storage.get("toggleState", (data) => {
  toggleElementsVisibility(data.toggleState ?? true);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "toggle_visibility") {
    toggleElementsVisibility(message.state);
  } else if (message.action === "remove_clicked_element") {
    // 右クリックした要素を選んだ状態で表示モードに入る
    if (displayMode) openRemoveMode(lastRightClick);
    else setMode(false, lastRightClick);
  }
});

// 右クリックされた位置を覚えておく
let lastRightClick = null;
document.addEventListener("contextmenu", (event) => {
  lastRightClick = { x: event.clientX, y: event.clientY };
}, true);

// 現在のURLに該当するルールのセレクタ一覧を返す
function getMatchingSelectors(rules) {
  return Object.entries(rules ?? {})
    .filter(([site]) => currentURL.includes(site))
    .flatMap(([, selectors]) => selectors);
}

// state が true なら非表示、false なら薄く表示してルールをツールチップで見られるようにする
function applyRemoveRule(el, selector, state) {
  if (state) {
    el.style.display = "none";  // 非表示
    el.style.opacity = "";
    el.removeAttribute("data-hide-rule");
  } else {
    el.style.display = "";  // 表示
    el.style.opacity = "0.1";
    el.setAttribute("data-hide-rule", selector);
    el.querySelectorAll("*").forEach(child => {
      child.setAttribute("data-hide-rule", selector);
    });
  }
}

// 現在のURLに該当する削除ルールを全部適用し、後から追加される要素の監視も始める
function applyRemoveRules(removeRules, state) {
  if (!removeRules) return;
  const selectors = getMatchingSelectors(removeRules);
  selectors.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => applyRemoveRule(el, selector, state));
  });
  manageObserver(selectors);
}

// state が true なら非表示モード、false なら表示モード（＝消すモード）にする
function toggleElementsVisibility(state, revealPoint) {
  displayMode = !state;
  storage.get(["removeRules", "clickRules"], ({ removeRules, clickRules }) => {
    applyRemoveRules(removeRules, state);

    getMatchingSelectors(clickRules).forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        console.log(`クリック: <${el.tagName.toLowerCase()} class="${el.className}" id="${el.id}">`);
        el.click();
      });
    });

    if (displayMode) openRemoveMode(revealPoint);
    else closeRemoveMode();
  });
}

// モードを切り替えて保存する（アイコンを押したときと同じ）
function setMode(state, revealPoint) {
  storage.set({ toggleState: state });
  toggleElementsVisibility(state, revealPoint);
}

// 後から追加された要素にもルールを適用する
function manageObserver(selectors) {
  if (observer) observer.disconnect();

  observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        selectors.forEach(selector => {
          if (node.matches(selector)) applyRemoveRule(node, selector, !displayMode);
          node.querySelectorAll(selector).forEach(child => applyRemoveRule(child, selector, !displayMode));
        });
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// 要素を # (id) か . (クラス) で指すセレクタを作る。
// どちらもない要素は、id かクラスを持つ一番近い親を使って「親 タグ」の形にする
function buildSelector(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${CSS.escape(el.id)}`;

  const classes = [...el.classList].map(c => `.${CSS.escape(c)}`).join("");
  if (classes) return tag + classes;

  const ancestor = el.parentElement?.closest("[id], [class]");
  if (!ancestor || ancestor === document.body || ancestor === document.documentElement) return tag;
  return `${buildSelector(ancestor)} ${tag}`;
}

// 同じタグの兄弟の中で何番目か（1始まり）。同じタグの兄弟がいなければ 0
function nthOfType(el) {
  const parent = el.parentElement;
  if (!parent) return 0;
  const sameTag = [...parent.children].filter(c => c.tagName === el.tagName);
  return sameTag.length > 1 ? sameTag.indexOf(el) + 1 : 0;
}

// 要素を「何番目か」で指すセレクタを作る。id を持つ親か body まで「>」でたどる
function buildNthSelector(el) {
  const tag = el.tagName.toLowerCase();
  if (el === document.body) return "body";
  if (el.id) return `${tag}#${CSS.escape(el.id)}`;
  const n = nthOfType(el);
  const self = n ? `${tag}:nth-of-type(${n})` : tag;
  return el.parentElement ? `${buildNthSelector(el.parentElement)} > ${self}` : self;
}

// 選んだ要素に使えるセレクタの候補を返す。id・クラスの組み合わせのあとに、何番目かで指すものを並べる
function suggestSelectors(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? CSS.escape(el.id) : "";
  const classes = [...el.classList].map(c => `.${CSS.escape(c)}`);

  const suggestions = [buildSelector(el)];
  if (id) suggestions.push(`#${id}`);
  if (classes.length > 0) {
    suggestions.push(tag + classes.join(""));
    if (classes.length > 1) suggestions.push(classes.join(""));
    classes.forEach(c => suggestions.push(c, tag + c));
  }

  const n = nthOfType(el);
  if (n && el.parentElement) {
    suggestions.push(`${buildSelector(el.parentElement)} > ${tag}:nth-of-type(${n})`);
  }
  suggestions.push(buildNthSelector(el));
  return [...new Set(suggestions)].filter(selector => {
    try {
      return el.matches(selector);
    } catch (e) {
      return false;
    }
  });
}

// 指定した位置に重なっている要素（親要素・重なったオーバーレイを含む）を手前から順に返す
function getLayerCandidates({ x, y }) {
  return document.elementsFromPoint(x, y)
    .filter(el => el !== document.documentElement && el !== document.body && !el.closest("#rm-elem-picker"))
    .slice(0, 15);
}

// このページに適用されているルールを { site, selector, count, invalid } の配列で返す
function getPageRules(callback) {
  storage.get("removeRules", ({ removeRules = {} }) => {
    const rules = [];
    Object.entries(removeRules)
      .filter(([site]) => currentURL.includes(site))
      .forEach(([site, selectors]) => {
        selectors.forEach(selector => {
          try {
            rules.push({ site, selector, count: document.querySelectorAll(selector).length });
          } catch (e) {
            rules.push({ site, selector, count: 0, invalid: true });
          }
        });
      });
    callback(rules);
  });
}

// セレクタで要素を消すルールを追加して保存する
function removeBySelector(selector, onDone) {
  if (!selector) return;

  let targets;
  try {
    targets = document.querySelectorAll(selector);
  } catch (e) {
    alert(`セレクタが正しくありません: ${selector}`);
    return;
  }

  const site = window.location.origin;
  storage.get("removeRules", ({ removeRules = {} }) => {
    const selectors = removeRules[site] ?? [];
    if (!selectors.includes(selector)) {
      removeRules[site] = [...selectors, selector];
      storage.set({ removeRules });
    }
    targets.forEach(el => applyRemoveRule(el, selector, !displayMode));
    manageObserver(getMatchingSelectors(removeRules));
    onDone?.();
  });
}

// ルールを削除して保存し、そのルールで消していた要素を元に戻す
function deleteRule(site, selector, onDone) {
  storage.get("removeRules", ({ removeRules = {} }) => {
    removeRules[site] = (removeRules[site] ?? []).filter(s => s !== selector);
    if (removeRules[site].length === 0) delete removeRules[site];
    storage.set({ removeRules });

    try {
      document.querySelectorAll(selector).forEach(el => {
        el.style.display = "";
        el.style.opacity = "";
        [el, ...el.querySelectorAll("[data-hide-rule]")].forEach(node => node.removeAttribute("data-hide-rule"));
      });
    } catch (e) {
      // 不正なセレクタのルールは消すだけ
    }
    // ほかのルールにも当てはまる要素はそのまま消えた状態にする
    applyRemoveRules(removeRules, !displayMode);
    onDone?.();
  });
}

// 表示モード中、ページ上の要素にマウスを乗せると onHover を呼び、
// クリックするとその位置の要素を選ぶ（ページ側のクリック動作は止める）
function startPickMode({ host, onHover }, onPick) {
  const style = document.createElement("style");
  style.textContent = "html.rm-elem-picking, html.rm-elem-picking * { cursor: crosshair !important; }";
  document.documentElement.appendChild(style);
  document.documentElement.classList.add("rm-elem-picking");

  const isOwn = (event) => event.composedPath().includes(host);

  // マウスの下の要素が変わったときだけ onHover を呼ぶ
  let hovered = null;
  const onMove = (event) => {
    const el = isOwn(event) ? null : getLayerCandidates({ x: event.clientX, y: event.clientY })[0] ?? null;
    if (el === hovered) return;
    hovered = el;
    onHover(el);
  };
  const block = (event) => {
    if (isOwn(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const onClick = (event) => {
    if (isOwn(event)) return;
    block(event);
    onPick({ x: event.clientX, y: event.clientY });
  };

  const blockedEvents = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick"];
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  blockedEvents.forEach(type => document.addEventListener(type, block, true));

  return () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    blockedEvents.forEach(type => document.removeEventListener(type, block, true));
    document.documentElement.classList.remove("rm-elem-picking");
    style.remove();
  };
}

const TREE_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "TITLE", "BASE"]);

// ツリーに出す要素か（見た目に関係ない要素と、この拡張機能が作った要素は出さない）
function isTreeTarget(el) {
  return !TREE_SKIP_TAGS.has(el.tagName) && el.id !== "rm-elem-picker" && el !== tooltip;
}

// ルールで消えている（表示モードでは薄く表示されている）要素か
function isHiddenByRule(el) {
  return el.hasAttribute("data-hide-rule") || getComputedStyle(el).display === "none";
}

// 開発者ツールの Elements パネルのような要素ツリーを container の中に作る。
// 子要素は開いたときに初めて作るので、大きなページでも重くならない
function createElementTree(container, { showHover, onSelect, onEnter }) {
  const nodes = new Map();      // 要素 → ツリーの行の情報
  const rowToEl = new WeakMap(); // 行 → 要素
  let selectedRow = null;

  const childTargets = (el) => [...el.children].filter(isTreeTarget);

  // <tag#id.class1.class2> の形で色分けして表示する
  const renderLabel = (el) => {
    const label = document.createElement("span");
    const part = (className, text) => {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text;
      label.appendChild(span);
    };
    part("tag", `<${el.tagName.toLowerCase()}`);
    if (el.id) part("id", `#${el.id}`);
    if (el.classList.length > 0) part("cls", [...el.classList].map(c => `.${c}`).join(""));
    part("tag", ">");
    return label;
  };

  const createNode = (el, depth) => {
    const node = document.createElement("div");
    const row = document.createElement("div");
    row.className = "row";
    row.style.paddingLeft = `${depth * 14 + 4}px`;
    row.classList.toggle("dim", isHiddenByRule(el));

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    const hasChildren = childTargets(el).length > 0;
    twisty.textContent = hasChildren ? "▶" : "";
    row.append(twisty, renderLabel(el));

    const children = document.createElement("div");
    children.hidden = true;
    node.append(row, children);

    const info = { el, depth, row, twisty, children, hasChildren, expanded: false, rendered: false };
    nodes.set(el, info);
    rowToEl.set(row, el);

    twisty.addEventListener("click", (event) => {
      event.stopPropagation();
      expand(info, !info.expanded);
    });
    row.addEventListener("click", () => select(el));
    row.addEventListener("mouseenter", () => showHover(el));
    row.addEventListener("mouseleave", () => showHover(null));
    return node;
  };

  const expand = (info, open) => {
    if (!info.hasChildren) return;
    if (open && !info.rendered) {
      childTargets(info.el).forEach(child => info.children.appendChild(createNode(child, info.depth + 1)));
      info.rendered = true;
    }
    info.expanded = open;
    info.children.hidden = !open;
    info.twisty.textContent = open ? "▼" : "▶";
  };

  const select = (el) => {
    const info = nodes.get(el);
    if (!info) return;
    selectedRow?.classList.remove("selected");
    selectedRow = info.row;
    selectedRow.classList.add("selected");
    selectedRow.scrollIntoView({ block: "nearest" });
    onSelect(el);
  };

  // body からその要素までの親を順に開いて、その要素の行の情報を返す
  const expandTo = (el) => {
    const path = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) path.unshift(e);
    let info = nodes.get(document.body);
    for (const e of path) {
      expand(info, true);
      info = nodes.get(e);
      if (!info) return null;  // ツリーに出さない要素の中にある
    }
    return info;
  };

  // その要素の行まで開いて選択する
  const reveal = (el) => {
    if (expandTo(el)) select(el);
  };

  // ページ上でマウスが乗っている要素の行まで開いて、点線で囲んで見せる（選択はしない）
  let peekRow = null;
  const peek = (el) => {
    peekRow?.classList.remove("peek");
    peekRow = null;
    const info = el && expandTo(el);
    if (!info) return;
    peekRow = info.row;
    peekRow.classList.add("peek");
    peekRow.scrollIntoView({ block: "nearest" });
  };

  // ↑↓で前後の行、→で開く／子へ、←で閉じる／親へ、Enterで消す
  const onKeyDown = (event) => {
    if (container.hidden || event.composedPath()[0]?.tagName === "INPUT" || !selectedRow) return;
    const el = rowToEl.get(selectedRow);
    const info = nodes.get(el);
    const visibleRows = [...container.querySelectorAll(".row")].filter(row => row.offsetParent !== null);
    const index = visibleRows.indexOf(selectedRow);

    if (event.key === "ArrowDown" && index < visibleRows.length - 1) {
      select(rowToEl.get(visibleRows[index + 1]));
    } else if (event.key === "ArrowUp" && index > 0) {
      select(rowToEl.get(visibleRows[index - 1]));
    } else if (event.key === "ArrowRight") {
      if (info.hasChildren && !info.expanded) expand(info, true);
      else if (info.expanded) select(childTargets(el)[0]);
    } else if (event.key === "ArrowLeft") {
      if (info.expanded) expand(info, false);
      else if (nodes.has(el.parentElement)) select(el.parentElement);
    } else if (event.key === "Enter") {
      onEnter();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("keydown", onKeyDown, true);

  container.appendChild(createNode(document.body, 0));
  expand(nodes.get(document.body), true);

  return {
    reveal,
    peek,
    // ルールを追加・削除したあとに、行の薄い表示を付け直す
    refreshDim: () => nodes.forEach(({ el, row }) => row.classList.toggle("dim", isHiddenByRule(el))),
    destroy: () => document.removeEventListener("keydown", onKeyDown, true),
  };
}

const PANEL_STYLE = `
  .highlight, .hover { position: fixed; pointer-events: none; display: none; }
  .highlight { z-index: 2147483646; background: rgba(255, 80, 80, 0.25); outline: 2px solid #ff5050; }
  .hover { z-index: 2147483645; background: rgba(80, 140, 255, 0.15); outline: 2px dashed #508cff; }
  .panel {
    position: fixed; right: 0; bottom: 0; left: 0; height: 40vh; z-index: 2147483647;
    display: flex; flex-direction: column;
    background: #fff; color: #222; font: 12px/1.4 Arial, sans-serif;
    box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.3);
  }
  .panel.floating {
    right: auto; bottom: auto; min-width: 320px; min-height: 160px;
    border-radius: 8px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35); overflow: hidden; resize: both;
  }
  .title { display: flex; gap: 12px; align-items: center; padding: 4px 10px; background: #333; color: #fff; cursor: move; user-select: none; }
  .title-text { font-weight: bold; white-space: nowrap; }
  .hint { flex: 1; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tabs { display: flex; gap: 2px; }
  .title button { padding: 2px 10px; border: none; border-radius: 4px; background: #555; color: #fff; cursor: pointer; white-space: nowrap; }
  .title .tab.active { background: #ff5050; }
  .view { flex: 1; overflow: auto; }
  .view[hidden] { display: none; }
  .tree { padding: 4px 0; font: 12px/1.7 monospace; }
  .row { white-space: nowrap; cursor: pointer; padding-right: 10px; }
  .row:hover { background: #eef4ff; }
  .row.peek { background: #eef4ff; outline: 1px dashed #508cff; outline-offset: -1px; }
  .row.selected { background: #ffd6d6; }
  .row.dim { opacity: 0.45; }
  .twisty { display: inline-block; width: 14px; text-align: center; color: #666; font-size: 9px; }
  .tag { color: #881280; }
  .id { color: #1a1aa6; }
  .cls { color: #994500; }
  .rule-row { display: flex; gap: 8px; align-items: center; padding: 4px 10px; border-bottom: 1px solid #eee; cursor: pointer; }
  .rule-row:hover { background: #eef4ff; }
  .rule-row.none { color: #aaa; }
  .rule-row .label { flex: 1; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rule-row .sub { color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
  .empty { padding: 12px; color: #888; }
  .footer { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 10px; border-top: 1px solid #ddd; }
  .footer[hidden] { display: none; }
  input { width: 280px; max-width: 100%; font: 12px monospace; padding: 4px; box-sizing: border-box; }
  .chips { flex: 1 1 200px; display: flex; flex-wrap: wrap; gap: 4px; max-height: 48px; overflow-y: auto; }
  .chip {
    font: 11px monospace; padding: 2px 6px; border: 1px solid #ccc; border-radius: 10px;
    background: #f7f7f7; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chip:hover { background: #ffecec; border-color: #ff5050; }
  .chip.active { background: #ffd6d6; border-color: #ff5050; }
  .count { color: #888; white-space: nowrap; }
  button.confirm, button.del { padding: 4px 12px; background: #ff5050; color: #fff; border: none; border-radius: 4px; cursor: pointer; white-space: nowrap; }
  button.del { padding: 2px 8px; }
  .applied { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; color: #555; }
  .applied[hidden] { display: none; }
`;

function openRemoveMode(revealPoint) {
  if (!removeMode) removeMode = createRemoveMode();
  if (revealPoint) removeMode.revealAt(revealPoint);
}

function closeRemoveMode() {
  removeMode?.close();
}

// 表示モード（＝消すモード）の画面。画面下に要素ツリーを出し、選んだ要素を消したり、
// ルールを削除したりできる。パネルを閉じると非表示モードに戻る
function createRemoveMode() {
  const html = document.documentElement;
  const originalPadding = html.style.paddingBottom;

  // ページのCSSの影響を受けないように Shadow DOM の中に作る
  const host = document.createElement("div");
  host.id = "rm-elem-picker";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${PANEL_STYLE}</style>
    <div class="hover"></div>
    <div class="highlight"></div>
    <div class="panel">
      <div class="title" title="ドラッグで移動 / ダブルクリックで画面下に戻す">
        <span class="title-text">表示モード</span>
        <span class="hint">ページ上をクリックで選択 / ↑↓←→で移動・開閉 / Enterで消す / Escで終了</span>
        <span class="tabs">
          <button class="tab active" data-view="tree">要素</button>
          <button class="tab" data-view="rules">ルール一覧</button>
        </span>
        <button class="exit">終了</button>
      </div>
      <div class="view tree"></div>
      <div class="view rules" hidden></div>
      <div class="footer">
        <input type="text" placeholder="セレクタ">
        <div class="chips"></div>
        <span class="count"></span>
        <button class="confirm">消す</button>
        <div class="applied" hidden></div>
      </div>
    </div>`;

  const $ = (selector) => root.querySelector(selector);
  const highlight = $(".highlight");
  const hover = $(".hover");
  const panelEl = $(".panel");
  const title = $(".title");
  const treeView = $(".tree");
  const rulesView = $(".rules");
  const footer = $(".footer");
  const input = $("input");
  const chips = $(".chips");
  const count = $(".count");
  const applied = $(".applied");
  let selectedEl = null;

  const placeBox = (box, el) => {
    if (!el) {
      box.style.display = "none";
      return;
    }
    const rect = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: "block",
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
  };
  const showHover = (el) => placeBox(hover, el);

  // パネルに隠れていない範囲に見えているか
  const isInViewport = (el) => {
    const rect = el.getBoundingClientRect();
    const visibleBottom = panelPosition ? window.innerHeight : panelEl.getBoundingClientRect().top;
    return rect.bottom > 0 && rect.top < visibleBottom;
  };

  const updateCount = () => {
    try {
      count.textContent = `${document.querySelectorAll(input.value).length} 個の要素が対象`;
    } catch (e) {
      count.textContent = "セレクタが正しくありません";
    }
    chips.querySelectorAll(".chip").forEach(chip => chip.classList.toggle("active", chip.dataset.selector === input.value));
  };

  // セレクタの候補をボタンで並べ、押すと入力欄に入れる
  const showSuggestions = (el) => {
    chips.innerHTML = "";
    suggestSelectors(el).forEach(selector => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.dataset.selector = selector;
      chip.textContent = `${selector} (${document.querySelectorAll(selector).length})`;
      chip.title = chip.textContent;
      chip.addEventListener("click", () => {
        input.value = selector;
        updateCount();
      });
      chips.appendChild(chip);
    });
  };

  // 選んだ要素（またはその親）を消しているルールを、削除ボタン付きで出す
  const showAppliedRules = (el) => {
    getPageRules(rules => {
      const matches = rules.filter(rule => !rule.invalid && el.closest(rule.selector));
      applied.innerHTML = "";
      applied.hidden = matches.length === 0;
      if (matches.length === 0) return;

      applied.append("この要素を消しているルール：");
      matches.forEach(({ site, selector }) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = `${selector} ×`;
        chip.title = `${site || "全サイト"} のルールを削除`;
        chip.addEventListener("click", () => deleteRule(site, selector, refresh));
        applied.appendChild(chip);
      });
    });
  };

  const selectElement = (el) => {
    selectedEl = el;
    if (!isInViewport(el)) el.scrollIntoView({ block: "center" });
    placeBox(highlight, el);
    input.value = buildSelector(el);
    showSuggestions(el);
    updateCount();
    showAppliedRules(el);
  };

  const confirmRemove = () => removeBySelector(input.value.trim(), refresh);

  const tree = createElementTree(treeView, { showHover, onSelect: selectElement, onEnter: confirmRemove });

  // このページに適用されているルールの一覧。要素があるルールを先に並べる
  const renderRules = () => {
    getPageRules(rules => {
      rulesView.innerHTML = "";
      if (rules.length === 0) {
        rulesView.innerHTML = `<div class="empty">このページに適用されているルールはありません</div>`;
        return;
      }
      rules.sort((a, b) => (b.count > 0) - (a.count > 0));
      rules.forEach(({ site, selector, count, invalid }) => {
        const first = invalid ? null : document.querySelector(selector);
        const row = document.createElement("div");
        row.className = count > 0 ? "rule-row" : "rule-row none";
        row.innerHTML = `<span class="label"></span><span class="sub"></span><button class="del">削除</button>`;
        row.querySelector(".label").textContent = selector;
        row.querySelector(".label").title = selector;
        row.querySelector(".sub").textContent = invalid ? "不正なセレクタ" : `${count}個・${site || "全サイト"}`;
        row.addEventListener("mouseenter", () => showHover(first));
        row.addEventListener("mouseleave", () => showHover(null));
        // 行を押すと、その要素をツリーで選ぶ
        row.addEventListener("click", () => {
          if (!first) return;
          switchView("tree");
          tree.reveal(first);
        });
        row.querySelector(".del").addEventListener("click", (event) => {
          event.stopPropagation();
          deleteRule(site, selector, refresh);
        });
        rulesView.appendChild(row);
      });
    });
  };

  const switchView = (view) => {
    treeView.hidden = view !== "tree";
    footer.hidden = view !== "tree";
    rulesView.hidden = view !== "rules";
    root.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === view));
    if (view === "rules") renderRules();
  };

  // ルールを追加・削除したあとに表示を最新にする
  const refresh = () => {
    tree.refreshDim();
    if (selectedEl) {
      showSuggestions(selectedEl);
      updateCount();
      showAppliedRules(selectedEl);
    }
    if (!rulesView.hidden) renderRules();
  };

  // 指定した位置の一番手前の要素をツリーで選ぶ
  const revealAt = (point) => {
    const el = getLayerCandidates(point)[0];
    if (!el) return;
    switchView("tree");
    tree.reveal(el);
  };

  root.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => switchView(tab.dataset.view)));
  input.addEventListener("input", updateCount);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") confirmRemove();
  });
  $(".confirm").addEventListener("click", confirmRemove);
  $(".exit").addEventListener("click", () => close());

  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
  };
  const onScroll = () => placeBox(highlight, selectedEl);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  // パネルの位置。null なら画面下に固定、{ left, top, width, height } なら自由な位置に浮かせる
  let panelPosition = null;
  const applyPosition = () => {
    panelEl.classList.toggle("floating", !!panelPosition);
    if (panelPosition) {
      // 画面からはみ出さないように収める
      const width = Math.min(panelPosition.width, window.innerWidth);
      const height = Math.min(panelPosition.height, window.innerHeight);
      Object.assign(panelEl.style, {
        width: `${width}px`,
        height: `${height}px`,
        left: `${Math.min(Math.max(panelPosition.left, 0), window.innerWidth - width)}px`,
        top: `${Math.min(Math.max(panelPosition.top, 0), window.innerHeight - height)}px`,
      });
      html.style.paddingBottom = originalPadding;
    } else {
      panelEl.removeAttribute("style");
      // パネルに隠れないように、ページの最後まで見えるよう下に余白を足す
      html.style.paddingBottom = "40vh";
    }
  };
  const savePosition = () => {
    if (panelPosition) {
      const { left, top, width, height } = panelEl.getBoundingClientRect();
      panelPosition = { left, top, width, height };
    }
    storage.set({ panelPosition });
  };

  // タイトルをドラッグして移動する。画面下に固定されているときは、動かし始めたときに浮かせる
  let drag = null;
  let suppressClick = false;
  title.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    drag = { startX: event.clientX, startY: event.clientY, moved: false };
    event.preventDefault();
  });
  const onDragMove = (event) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) < 5) return;
      if (!panelPosition) {
        const rect = panelEl.getBoundingClientRect();
        const width = Math.min(640, window.innerWidth - 20);
        const left = drag.startX - Math.min(drag.startX - rect.left, width - 40);
        panelPosition = { left, top: rect.top, width, height: rect.height };
        applyPosition();
      }
      const rect = panelEl.getBoundingClientRect();
      drag.dx = drag.startX - rect.left;
      drag.dy = drag.startY - rect.top;
      drag.moved = true;
    }
    panelPosition = { ...panelPosition, left: event.clientX - drag.dx, top: event.clientY - drag.dy };
    applyPosition();
  };
  const onDragEnd = () => {
    if (drag?.moved) {
      savePosition();
      // ページの上でマウスを離したときに、その位置の要素が選ばれないようにする
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    }
    drag = null;
  };
  window.addEventListener("mousemove", onDragMove, true);
  window.addEventListener("mouseup", onDragEnd, true);

  // タイトルをダブルクリックすると画面下に戻す
  title.addEventListener("dblclick", (event) => {
    if (event.target.closest("button")) return;
    panelPosition = null;
    applyPosition();
    savePosition();
  });

  // 右下の角で大きさを変えたら保存する
  let resizeTimer = null;
  const resizeObserver = new ResizeObserver(() => {
    if (!panelPosition || drag) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(savePosition, 300);
  });
  resizeObserver.observe(panelEl);
  window.addEventListener("resize", applyPosition);

  // ページ上でマウスを乗せた要素を点線で囲み、ツリーでもその行に飛ぶ
  const onPageHover = (el) => {
    if (drag) return;
    showHover(el);
    if (!treeView.hidden) tree.peek(el);
  };
  const stopPickMode = startPickMode({ host, onHover: onPageHover }, (point) => {
    if (!suppressClick) revealAt(point);
  });

  applyPosition();
  html.appendChild(host);
  // 前回の位置があれば、そこに出す
  storage.get("panelPosition", ({ panelPosition: saved }) => {
    if (!saved || !host.isConnected) return;
    panelPosition = saved;
    applyPosition();
  });

  const close = () => {
    host.remove();
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("mousemove", onDragMove, true);
    window.removeEventListener("mouseup", onDragEnd, true);
    window.removeEventListener("resize", applyPosition);
    resizeObserver.disconnect();
    clearTimeout(resizeTimer);
    stopPickMode();
    tree.destroy();
    html.style.paddingBottom = originalPadding;
    removeMode = null;
    // パネルを閉じたら非表示モードに戻す（アイコンで戻したときは displayMode がもう false）
    if (displayMode) setMode(true);
  };

  return { revealAt, close };
}

// ✅ ツールチップの追加処理
const tooltip = document.createElement("div");
Object.assign(tooltip.style, {
  position: "fixed",
  backgroundColor: "rgba(0, 0, 0, 0.8)",
  color: "white",
  padding: "5px 10px",
  borderRadius: "5px",
  fontSize: "12px",
  display: "none",
  zIndex: "9999",
});
document.body.appendChild(tooltip);

document.addEventListener("mouseover", (event) => {
  const rule = event.target.getAttribute("data-hide-rule");
  if (rule) {
    tooltip.textContent = `Hidden by rule: ${rule}`;
    tooltip.style.display = "block";
    tooltip.style.left = `${event.pageX + 10}px`;
    tooltip.style.top = `${event.pageY + 10}px`;
  }
});

document.addEventListener("mouseout", () => {
  tooltip.style.display = "none";
});
