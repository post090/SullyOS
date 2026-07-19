"""幂等补丁：修复 xiaohongshu-skills 长文模式正文写入到错误编辑器的问题。

上游 publish_long_article.py 复用了普通图文的 div.ql-editor；小红书长文页实际使用
contenteditable/ProseMirror 编辑器，导致标题写入成功但正文始终为 0 字。

本补丁会替换 _fill_long_content：
1. 从可见 contenteditable/ProseMirror/role=textbox 中选择面积最大的正文编辑器；
2. 排除 input/textarea 与标题区域；
3. 用现有 CDP 键盘输入；
4. 回读文本，正文为空时明确失败，禁止继续排版或发布。
"""

from __future__ import annotations

import sys
from pathlib import Path

PATCH_MARKER = "SULLY_LONG_EDITOR_PATCH_V8"
BRIDGE_MARKER = "SULLY_BRIDGEPAGE_INSERT_TEXT_V2"
BRIDGE_START = "    def get_element_text(self, selector: str) -> str | None:\n"
BRIDGE_INSERT_TEXT = '''    # SULLY_BRIDGEPAGE_INSERT_TEXT_V2: 通过扩展后台强制调用 CDP Input.insertText。
    def insert_text(self, text: str) -> None:
        """将文本插入当前焦点编辑器，不经过 content.js/execCommand。"""
        self._call("insert_text", {"text": text})

'''
BACKGROUND_MARKER = "SULLY_BACKGROUND_INSERT_TEXT_V1"
BACKGROUND_ROUTE_ANCHOR = '''    case "type_text":
      return await cmdTypeTextViaDebugger(params);
'''
BACKGROUND_ROUTE_REPLACEMENT = '''    case "type_text":
      return await cmdTypeTextViaDebugger(params);

    // SULLY_BACKGROUND_INSERT_TEXT_V1: TipTap/ProseMirror 强制走 CDP Input.insertText。
    case "insert_text":
      return await cmdInsertTextViaDebugger(params);
'''
BACKGROUND_FUNCTION_ANCHOR = "// ───────────────────────── 文件上传（chrome.debugger + CDP） ─────────\n"
BACKGROUND_INSERT_FUNCTION = '''// SULLY_BACKGROUND_INSERT_TEXT_V1
async function cmdInsertTextViaDebugger({ text }) {
  const tab = await getOrOpenXhsTab();
  const target = { tabId: tab.id };
  await chrome.debugger.detach(target).catch(() => {});
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Input.insertText", { text: String(text || "") });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
  return null;
}

'''
START = "def _fill_long_content(page: Page, content: str) -> None:\n"

END = "\ndef _insert_images_to_editor(page: Page, image_paths: list[str]) -> None:\n"
NEXT_START = "def click_next_and_fill_description(page: Page, description: str) -> None:\n"
NEXT_END = "\n\n# ========== 内部辅助函数 ==========\n"

REPLACEMENT = '''def _fill_long_content(page: Page, content: str) -> None:
    """通过页面语义与真实焦点定位正文区，不依赖单一易变 class。"""
    if not content.strip():
        raise PublishError("长文正文为空，已停止发布")

    # SULLY_LONG_EDITOR_PATCH_V8：优先可见提示；提示由 CSS 伪元素渲染时，
    # 回退到可见可编辑元素，并按 contenteditable / tiptap / ProseMirror 语义加权。
    target = page.evaluate(
        r"""
        (() => {
            const hint = '输入文字，内容将自动保存';
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 20 && r.height > 10 &&
                    s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
            };
            const all = Array.from(document.querySelectorAll('body *'));
            const hintNodes = all.filter((el) => visible(el) && (
                (el.textContent || '').trim().includes(hint) ||
                String(el.getAttribute('placeholder') || '').includes('输入文字') ||
                String(el.getAttribute('data-placeholder') || '').includes('输入文字')
            ));
            hintNodes.sort((a, b) => {
                const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                return (ar.width * ar.height) - (br.width * br.height);
            });

            const editableNodes = Array.from(document.querySelectorAll(
                '[contenteditable="true"], [role="textbox"], .tiptap, .ProseMirror'
            )).filter((el) => {
                if (!visible(el) || el.matches('input, textarea')) return false;
                if (el.closest('.title-container') || el.getAttribute('placeholder') === '输入标题') return false;
                return true;
            });
            const score = (el) => {
                const r = el.getBoundingClientRect();
                const cls = String(el.className || '').toLowerCase();
                let value = Math.min(r.width * r.height, 1000000) / 1000;
                if (el.getAttribute('contenteditable') === 'true') value += 10000;
                if (cls.includes('tiptap')) value += 5000;
                if (cls.includes('prosemirror')) value += 5000;
                if (el.getAttribute('role') === 'textbox') value += 2000;
                return value;
            };
            editableNodes.sort((a, b) => score(b) - score(a));

            const bestEditable = editableNodes[0] || null;
            let el = null;
            let source = 'editable-fallback';
            if (hintNodes[0]) {
                // 提示通常是编辑器内部的 <p> 或 CSS placeholder；必须向上找到真正的
                // contenteditable 宿主，不能把临时提示段落本身当成输入目标。
                const hintEditor = hintNodes[0].matches('[contenteditable="true"], [role="textbox"]')
                    ? hintNodes[0]
                    : hintNodes[0].closest('[contenteditable="true"], [role="textbox"], .tiptap, .ProseMirror');
                if (hintEditor && visible(hintEditor)) {
                    el = hintEditor;
                    source = 'hint-ancestor-editor';
                }
            }
            if (!el) el = bestEditable;
            if (!el) return null;
            if (el.getAttribute('contenteditable') !== 'true') {
                const nested = el.querySelector('[contenteditable="true"], [role="textbox"], .tiptap, .ProseMirror');
                if (nested && visible(nested)) el = nested;
            }
            document.querySelectorAll('[data-sully-long-editor-v5]').forEach(
                (node) => node.removeAttribute('data-sully-long-editor-v5')
            );
            el.setAttribute('data-sully-long-editor-v5', 'true');
            const r = el.getBoundingClientRect();
            return {
                x: r.left + Math.min(Math.max(r.width / 2, 12), r.width - 12),
                y: r.top + Math.min(Math.max(Math.min(r.height / 2, 60), 12), r.height - 12),
                tag: el.tagName,
                className: String(el.className || ''),
                editable: el.getAttribute('contenteditable'),
                role: el.getAttribute('role'),
                source,
                candidates: editableNodes.slice(0, 6).map((node) => ({
                    tag: node.tagName,
                    cls: String(node.className || '').slice(0, 100),
                    editable: node.getAttribute('contenteditable'),
                    role: node.getAttribute('role'),
                    score: score(node)
                }))
            };
        })()
        """
    )
    if not target:
        diagnostic = page.evaluate(
            r"""
            (() => Array.from(document.querySelectorAll('[contenteditable], [role="textbox"], textarea, input'))
                .filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                })
                .slice(0, 12)
                .map(el => ({
                    tag: el.tagName,
                    role: el.getAttribute('role'),
                    editable: el.getAttribute('contenteditable'),
                    placeholder: el.getAttribute('placeholder'),
                    cls: String(el.className || '').slice(0, 100)
                })))()
            """
        )
        raise PublishError(f"未找到长文正文区域；页面候选元素: {diagnostic}")

    logger.info("长文正文点击目标: %s", target)
    page.mouse_click(target["x"], target["y"])
    time.sleep(0.3)

    focus_before = page.evaluate(
        r"""
        (() => {
            let marked = document.querySelector('[data-sully-long-editor-v5="true"]');
            const visible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 20 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
            };
            // TipTap/Vue 可能在鼠标点击后重绘并丢掉临时标记；此时重新按正文语义选宿主。
            if (!visible(marked)) {
                const candidates = Array.from(document.querySelectorAll(
                    '[contenteditable="true"], [role="textbox"], .tiptap, .ProseMirror'
                )).filter((el) => {
                    if (!visible(el) || el.matches('input, textarea')) return false;
                    if (el.closest('.title-container') || el.getAttribute('placeholder') === '输入标题') return false;
                    return true;
                });
                const score = (el) => {
                    const r = el.getBoundingClientRect();
                    const cls = String(el.className || '').toLowerCase();
                    let value = Math.min(r.width * r.height, 1000000) / 1000;
                    if (el.getAttribute('contenteditable') === 'true') value += 10000;
                    if (cls.includes('tiptap')) value += 5000;
                    if (cls.includes('prosemirror')) value += 5000;
                    if (el.getAttribute('role') === 'textbox') value += 2000;
                    return value;
                };
                candidates.sort((a, b) => score(b) - score(a));
                marked = candidates[0] || null;
                if (marked) marked.setAttribute('data-sully-long-editor-v5', 'true');
            }
            let editor = marked;
            if (editor && editor.getAttribute('contenteditable') !== 'true') {
                editor = editor.querySelector('[contenteditable="true"], [role="textbox"], .tiptap, .ProseMirror') || editor;
            }
            let active = document.activeElement;
            const inEditor = editor && active && (active === editor || editor.contains(active));
            if (editor && !inEditor) {
                editor.focus();
                active = document.activeElement;
            }
            const focused = editor && active && (active === editor || editor.contains(active));
            return {
                focused: Boolean(focused),
                targetTag: editor ? editor.tagName : null,
                targetEditable: editor ? editor.getAttribute('contenteditable') : null,
                targetClass: editor ? String(editor.className || '').slice(0, 120) : null,
                activeTag: active ? active.tagName : null,
                activeEditable: active ? active.getAttribute('contenteditable') : null,
                activeClass: active ? String(active.className || '').slice(0, 120) : null
            };
        })()
        """
    )
    logger.info("长文输入前焦点: %s", focus_before)
    if not focus_before or not focus_before.get("focused"):
        raise PublishError(f"长文正文区域未获得输入焦点，已停止发布；目标={target}，焦点={focus_before}")

    # BridgePage 与 CDP Page 共同公开支持的输入接口；禁止调用实现私有方法。
    page.input_content_editable('[data-sully-long-editor-v5="true"]', content)
    time.sleep(0.8)

    verification = page.evaluate(
        f"""
        (() => {{
            const bodyText = document.body ? (document.body.innerText || '') : '';
            const matches = Array.from(bodyText.matchAll(/字数[：:]?[^0-9]*([0-9]+)/g));
            const counts = matches.map(m => Number(m[1])).filter(Number.isFinite);
            const active = document.activeElement;
            const activeText = active ? (active.innerText || active.textContent || active.value || '') : '';
            const probe = {json.dumps(content.strip()[:12])};
            return {{
                count: counts.length ? Math.max(...counts) : null,
                activeTextLength: activeText.trim().length,
                bodyContainsProbe: probe ? bodyText.includes(probe) : false,
                activeTag: active ? active.tagName : null
            }};
        }})()
        """
    ) or {}
    logger.info("长文正文写入验收: %s", verification)
    count = verification.get("count")
    if not ((isinstance(count, (int, float)) and count > 0) or
            verification.get("activeTextLength", 0) > 0 or
            verification.get("bodyContainsProbe")):
        raise PublishError(f"长文正文写入后仍为 0 字，已停止发布；焦点={focus_before}，验收={verification}")

    logger.info("已填写长文正文 (%d 字)", len(content))
    time.sleep(1)
'''
NEXT_REPLACEMENT = '''def click_next_and_fill_description(page: Page, description: str) -> None:
    """进入最终发布页，语义定位描述编辑器并验证写入结果。"""
    _click_button_by_text(page, NEXT_STEP_BUTTON_TEXT)
    time.sleep(_PAGE_LOAD_WAIT)

    if not description.strip():
        logger.info("最终发布页描述为空，跳过填写")
        return
    if len(description) > 1000:
        description = description[:800]
        logger.warning("描述超过1000字，已截断到800字")

    selector = '[data-sully-final-editor-v8="true"]'
    target = page.evaluate(
        r"""
        (() => {
            const visible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 100 && r.height > 40 &&
                    s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
            };
            const candidates = Array.from(document.querySelectorAll(
                '[contenteditable="true"], [role="textbox"], .ql-editor, .ProseMirror, textarea'
            )).filter((el) => {
                if (!visible(el)) return false;
                const placeholder = String(el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '');
                if (placeholder.includes('输入标题')) return false;
                if (el.closest('.title-container')) return false;
                return true;
            });
            const score = (el) => {
                const r = el.getBoundingClientRect();
                const placeholder = String(el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '');
                const cls = String(el.className || '').toLowerCase();
                let value = Math.min(r.width * r.height, 1000000) / 1000;
                if (placeholder.includes('正文描述') || placeholder.includes('真诚有价值')) value += 30000;
                if (el.getAttribute('contenteditable') === 'true') value += 10000;
                if (el.getAttribute('role') === 'textbox') value += 5000;
                if (cls.includes('ql-editor') || cls.includes('prosemirror')) value += 3000;
                return value;
            };
            candidates.sort((a, b) => score(b) - score(a));
            let editor = candidates[0] || null;
            if (!editor) {
                const all = Array.from(document.querySelectorAll('body *'));
                const hint = all.find((el) => visible(el) &&
                    (el.textContent || '').includes('输入正文描述'));
                if (hint) editor = hint.closest('[contenteditable="true"], [role="textbox"], .ql-editor, .ProseMirror') ||
                    hint.querySelector('[contenteditable="true"], [role="textbox"], .ql-editor, .ProseMirror');
            }
            if (!editor || !visible(editor)) return null;
            document.querySelectorAll('[data-sully-final-editor-v8]').forEach(
                (el) => el.removeAttribute('data-sully-final-editor-v8')
            );
            editor.setAttribute('data-sully-final-editor-v8', 'true');
            editor.scrollIntoView({block: 'center'});
            if (typeof editor.focus === 'function') editor.focus();
            return {
                tag: editor.tagName,
                cls: String(editor.className || '').slice(0, 120),
                editable: editor.getAttribute('contenteditable'),
                role: editor.getAttribute('role'),
                placeholder: editor.getAttribute('placeholder') || editor.getAttribute('data-placeholder'),
                candidates: candidates.slice(0, 8).map((el) => ({
                    tag: el.tagName,
                    cls: String(el.className || '').slice(0, 80),
                    placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),
                    editable: el.getAttribute('contenteditable'),
                    score: score(el)
                }))
            };
        })()
        """
    )
    if not target:
        raise PublishError("没有找到最终发布页正文描述输入框")

    logger.info("最终发布页描述编辑器: %s", target)
    page.select_all_text(selector)
    page.insert_text(description)
    time.sleep(0.8)

    verification = page.evaluate(
        f"""
        (() => {{
            const el = document.querySelector({json.dumps(selector)});
            const text = el ? (el.innerText || el.textContent || el.value || '').trim() : '';
            const bodyText = document.body ? (document.body.innerText || '') : '';
            const probe = {json.dumps(description.strip()[:12])};
            return {{
                textLength: text.length,
                bodyContainsProbe: probe ? bodyText.includes(probe) : false
            }};
        }})()
        """
    ) or {}
    if verification.get("textLength", 0) <= 0 and not verification.get("bodyContainsProbe"):
        raise PublishError(f"最终发布页正文描述写入失败，已停止发布；目标={target}，验收={verification}")
    logger.info("已填写最终发布页描述 (%d 字)", len(description))
'''

def _candidate_roots() -> list[Path]:
    here = Path(__file__).resolve().parent
    roots: list[Path] = []
    for base in [here, *here.parents]:
        for name in ("xiaohongshu-skills", "xiaohongshu-skills-main"):
            roots.append(base / name)
        # 当补丁脚本本身位于 skills/scripts/ 时也能找到仓库根。
        if (base / "scripts" / "xhs").is_dir() and (base / "extension").is_dir():
            roots.append(base)
    unique: list[Path] = []
    for root in roots:
        if root not in unique:
            unique.append(root)
    return unique


def find_publish_target() -> Path | None:
    candidates = [root / "scripts" / "xhs" / "publish_long_article.py" for root in _candidate_roots()]
    return next((path for path in candidates if path.is_file()), None)


def find_bridge_target() -> Path | None:
    candidates = [root / "scripts" / "xhs" / "bridge.py" for root in _candidate_roots()]
    return next((path for path in candidates if path.is_file()), None)


def find_background_target() -> Path | None:
    candidates = [root / "extension" / "background.js" for root in _candidate_roots()]
    return next((path for path in candidates if path.is_file()), None)


def build_bridge_patch(text: str) -> str | None:
    if BRIDGE_MARKER in text and 'self._call("insert_text"' in text:
        return text
    if text.count(BRIDGE_START) != 1:
        return None
    patched = text.replace(BRIDGE_START, BRIDGE_INSERT_TEXT + BRIDGE_START, 1)
    if BRIDGE_MARKER not in patched or 'self._call("insert_text"' not in patched:
        return None
    # 在写盘前用 Python 自身编译生成源码。
    compile(patched, "bridge.py", "exec")
    return patched


def build_background_patch(text: str) -> str | None:
    patched = text
    has_route = 'case "insert_text"' in patched and "cmdInsertTextViaDebugger(params)" in patched
    has_function = "async function cmdInsertTextViaDebugger" in patched and '"Input.insertText"' in patched

    if not has_route:
        if patched.count(BACKGROUND_ROUTE_ANCHOR) != 1:
            return None
        patched = patched.replace(BACKGROUND_ROUTE_ANCHOR, BACKGROUND_ROUTE_REPLACEMENT, 1)
    if not has_function:
        if patched.count(BACKGROUND_FUNCTION_ANCHOR) != 1:
            return None
        patched = patched.replace(
            BACKGROUND_FUNCTION_ANCHOR,
            BACKGROUND_INSERT_FUNCTION + BACKGROUND_FUNCTION_ANCHOR,
            1,
        )

    required = (
        'case "insert_text"',
        "cmdInsertTextViaDebugger(params)",
        "async function cmdInsertTextViaDebugger",
        '"Input.insertText"',
    )
    return patched if all(item in patched for item in required) else None


def build_publish_patch(text: str) -> str | None:
    if "page.insert_text(description)" in text and "data-sully-final-editor-v8" in text:
        return text

    fill_start = text.find(START)
    fill_end = text.find(END, fill_start + len(START)) if fill_start >= 0 else -1
    next_start = text.find(NEXT_START)
    next_end = text.find(NEXT_END, next_start + len(NEXT_START)) if next_start >= 0 else -1
    if min(fill_start, fill_end, next_start, next_end) < 0:
        return None

    patched = text[:next_start] + NEXT_REPLACEMENT + text[next_end:]
    fill_start = patched.find(START)
    fill_end = patched.find(END, fill_start + len(START)) if fill_start >= 0 else -1
    if fill_start < 0 or fill_end < 0:
        return None
    patched = patched[:fill_start] + REPLACEMENT + patched[fill_end:]

    required = (
        PATCH_MARKER,
        "data-sully-final-editor-v8",
        "page.insert_text(description)",
    )
    if not all(item in patched for item in required):
        return None
    compile(patched, "publish_long_article.py", "exec")
    return patched


def _write_backup(target: Path, original: str, suffix: str) -> None:
    backup = target.with_suffix(target.suffix + suffix)
    if not backup.exists():
        backup.write_text(original, encoding="utf-8")
        print(f"  [bak] {backup.name}")


def main() -> int:
    # 日常无参数自动发现；测试台可显式指定三个目标。
    args = sys.argv[1:]
    publish_target = find_publish_target()
    bridge_target = find_bridge_target()
    background_target = find_background_target()

    if args:
        if len(args) != 3:
            print("[error] 显式模式需要三个路径: publish_long_article.py bridge.py background.js")
            return 2
        publish_target = Path(args[0]).expanduser().resolve()
        bridge_target = Path(args[1]).expanduser().resolve()
        background_target = Path(args[2]).expanduser().resolve()

    targets = {
        "publish": publish_target,
        "bridge": bridge_target,
        "background": background_target,
    }
    for label, target in targets.items():
        if target is None or not target.is_file():
            print(f"[error] 找不到 {label} 目标: {target or '自动搜索失败'}")
            return 2
        print(f"[check] {label}_target={target}")

    originals = {
        "publish": publish_target.read_text(encoding="utf-8"),
        "bridge": bridge_target.read_text(encoding="utf-8"),
        "background": background_target.read_text(encoding="utf-8"),
    }

    try:
        generated = {
            "bridge": build_bridge_patch(originals["bridge"]),
            "background": build_background_patch(originals["background"]),
            "publish": build_publish_patch(originals["publish"]),
        }
    except (SyntaxError, ValueError) as exc:
        print(f"[error] 生成文件编译失败，拒绝写盘: {exc}")
        return 2

    failed = [name for name, content in generated.items() if content is None]
    if failed:
        print(f"[error] 补丁锚点或完整性检查失败，拒绝写盘: {', '.join(failed)}")
        return 2

    # 三份生成结果全部完成后才开始写盘；写入异常则恢复本轮原文。
    try:
        _write_backup(bridge_target, originals["bridge"], ".bak-sully-insert-text")
        _write_backup(background_target, originals["background"], ".bak-sully-insert-text")
        _write_backup(publish_target, originals["publish"], ".bak-sully-long")

        bridge_changed = generated["bridge"] != originals["bridge"]
        background_changed = generated["background"] != originals["background"]
        publish_changed = generated["publish"] != originals["publish"]

        bridge_target.write_text(generated["bridge"], encoding="utf-8")
        background_target.write_text(generated["background"], encoding="utf-8")
        publish_target.write_text(generated["publish"], encoding="utf-8")

        print(f"[{'done' if bridge_changed else 'skip'}] {bridge_target} BridgePage.insert_text")
        print(f"[{'done' if background_changed else 'skip'}] {background_target} Input.insertText 路由")
        print(f"[{'done' if publish_changed else 'skip'}] {publish_target} 长文正文与最终描述")
        return 0
    except Exception as exc:
        bridge_target.write_text(originals["bridge"], encoding="utf-8")
        background_target.write_text(originals["background"], encoding="utf-8")
        publish_target.write_text(originals["publish"], encoding="utf-8")
        print(f"[rollback] 三个目标已恢复本轮原文: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())