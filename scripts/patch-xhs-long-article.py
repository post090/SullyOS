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
CDP_MARKER = "SULLY_BRIDGEPAGE_INSERT_TEXT_V1"
CDP_START = "    def get_element_text(self, selector: str) -> str | None:\n"
CDP_INSERT_TEXT = '''    # SULLY_BRIDGEPAGE_INSERT_TEXT_V1: TipTap/ProseMirror 兼容文本插入。
    def insert_text(self, text: str) -> None:
        """将文本插入当前焦点编辑器，使用 CDP Input.insertText。"""
        self._send_session(
            "Input.insertText",
            {"text": text},
        )
        time.sleep(0.05)

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


def find_target() -> Path | None:
    here = Path(__file__).resolve().parent
    candidates: list[Path] = []
    for base in [here, *here.parents]:
        for name in ("xiaohongshu-skills", "xiaohongshu-skills-main"):
            candidates.append(base / name / "scripts" / "xhs" / "publish_long_article.py")
        candidates.append(base / "scripts" / "xhs" / "publish_long_article.py")
    return next((p for p in candidates if p.is_file()), None)

def find_cdp_target() -> Path | None:
    here = Path(__file__).resolve().parent
    candidates: list[Path] = []
    for base in [here, *here.parents]:
        for name in ("xiaohongshu-skills", "xiaohongshu-skills-main"):
            candidates.append(base / name / "scripts" / "xhs" / "cdp.py")
        candidates.append(base / "scripts" / "xhs" / "cdp.py")
    return next((p for p in candidates if p.is_file()), None)


def apply_cdp_patch(target: Path) -> int:
    text = target.read_text(encoding="utf-8")
    if CDP_MARKER in text:
        print(f"[skip] {target} BridgePage insert_text 补丁已存在。")
        return 0
    occurrences = text.count(CDP_START)
    if occurrences != 1:
        print(f"[error] {target} get_element_text 插入锚点匹配 {occurrences} 次，拒绝写盘。")
        return 2
    patched = text.replace(CDP_START, CDP_INSERT_TEXT + CDP_START, 1)
    if CDP_MARKER not in patched or "Input.insertText" not in patched:
        print(f"[error] {target} BridgePage insert_text 补丁生成不完整，拒绝写盘。")
        return 2
    backup = target.with_suffix(target.suffix + ".bak-sully-insert-text")
    if not backup.exists():
        backup.write_text(text, encoding="utf-8")
        print(f"  [bak] {backup.name}")
    target.write_text(patched, encoding="utf-8")
    print(f"[done] {target} 已加入公开 insert_text()。")
    return 0
def apply_publish_patch(target: Path) -> int:
    text = target.read_text(encoding="utf-8")
    if PATCH_MARKER in text:
        print(f"[skip] {target} 长文发布补丁已存在。")
        return 0

    fill_start = text.find(START)
    fill_end = text.find(END, fill_start + len(START)) if fill_start >= 0 else -1
    next_start = text.find(NEXT_START)
    next_end = text.find(NEXT_END, next_start + len(NEXT_START)) if next_start >= 0 else -1
    if fill_start < 0 or fill_end < 0:
        print(f"[error] {target} 中找不到 _fill_long_content 函数边界；可能上游已变更。")
        return 2
    if next_start < 0 or next_end < 0:
        print(f"[error] {target} 中找不到 click_next_and_fill_description 函数边界；可能上游已变更。")
        return 2

    # 从靠后的函数开始替换，避免前一段长度变化影响后一段索引。
    patched = text[:next_start] + NEXT_REPLACEMENT + text[next_end:]
    fill_start = patched.find(START)
    fill_end = patched.find(END, fill_start + len(START)) if fill_start >= 0 else -1
    if fill_start < 0 or fill_end < 0:
        print(f"[error] {target} 替换最终页逻辑后无法重新定位 _fill_long_content。")
        return 2
    patched = patched[:fill_start] + REPLACEMENT + patched[fill_end:]

    required = (
        PATCH_MARKER,
        "data-sully-final-editor-v8",
        "page.insert_text(description)",
    )
    if any(item not in patched for item in required):
        print(f"[error] {target} 补丁生成结果不完整，拒绝写盘。")
        return 2

    backup = target.with_suffix(target.suffix + ".bak-sully-long")
    if not backup.exists():
        backup.write_text(text, encoding="utf-8")
        print(f"  [bak] {backup.name}")
    target.write_text(patched, encoding="utf-8")
    print(f"[done] {target} 长文正文与最终发布页补丁已应用。")
    return 0

def validate_cdp_target(target: Path) -> bool:
    """只检查 cdp.py 是否有唯一插入锚点；不检查任何历史版本号。"""
    text = target.read_text(encoding="utf-8")
    return CDP_MARKER in text or text.count(CDP_START) == 1


def validate_publish_target(target: Path) -> bool:
    """只检查两个目标函数边界；不检查 V7/V8 或历史 marker。"""
    text = target.read_text(encoding="utf-8")
    if "page.insert_text(description)" in text:
        return True
    fill_start = text.find(START)
    fill_end = text.find(END, fill_start + len(START)) if fill_start >= 0 else -1
    next_start = text.find(NEXT_START)
    next_end = text.find(NEXT_END, next_start + len(NEXT_START)) if next_start >= 0 else -1
    return fill_start >= 0 and fill_end >= 0 and next_start >= 0 and next_end >= 0


def rollback_file(target: Path) -> None:
    """安装第二个文件失败时恢复本轮已写入的第一个文件。"""
    backup = target.with_suffix(target.suffix + ".bak-sully-insert-text")
    if backup.exists():
        target.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")

def main() -> int:
    # 支持无参数自动发现，也支持测试台/特殊目录显式指定两个目标。
    # 位置参数仍兼容：<publish_long_article.py> [cdp.py]
    raw_args = sys.argv[1:]
    publish_arg: str | None = None
    cdp_arg: str | None = None
    i = 0
    positional: list[str] = []
    while i < len(raw_args):
        arg = raw_args[i]
        if arg in ("--publish-file", "--publish"):
            if i + 1 >= len(raw_args):
                print(f"[error] {arg} 缺少文件路径")
                return 2
            publish_arg = raw_args[i + 1]
            i += 2
            continue
        if arg in ("--cdp-file", "--cdp"):
            if i + 1 >= len(raw_args):
                print(f"[error] {arg} 缺少文件路径")
                return 2
            cdp_arg = raw_args[i + 1]
            i += 2
            continue
        if arg.startswith("-"):
            print(f"[error] 未知参数: {arg}")
            return 2
        positional.append(arg)
        i += 1

    if publish_arg is None and positional:
        publish_arg = positional[0]
    if cdp_arg is None and len(positional) > 1:
        cdp_arg = positional[1]
    if len(positional) > 2:
        print("[error] 最多接受两个位置参数: publish_long_article.py [cdp.py]")
        return 2

    publish_target = (
        Path(publish_arg).expanduser().resolve() if publish_arg
        else find_target()
    )
    if publish_target is None or not publish_target.is_file():
        print(f"[error] 找不到发布脚本: {publish_target or '自动搜索失败'}")
        return 2

    if cdp_arg:
        cdp_target = Path(cdp_arg).expanduser().resolve()
    else:
        cdp_target = publish_target.with_name("cdp.py")
        if not cdp_target.is_file():
            cdp_target = find_cdp_target()
    if cdp_target is None or not cdp_target.is_file():
        print(f"[error] 找不到 cdp.py: {cdp_target or '自动搜索失败'}")
        return 2

    print(f"[check] publish_target={publish_target}")
    print(f"[check] cdp_target={cdp_target}")

    # 先完整预检两个目标，再执行任何写盘，避免留下半安装状态。
    if not validate_cdp_target(cdp_target):
        print(f"[error] {cdp_target} 的 insert_text 插入锚点异常，拒绝写盘。")
        return 2
    if not validate_publish_target(publish_target):
        print(f"[error] {publish_target} 的长文函数边界异常，拒绝写盘。")
        return 2

    # 保存本轮原文；如果第二个目标失败，只回滚本轮对 CDP 的修改，
    # 不依赖历史 .bak 文件，避免恢复到更早版本。
    cdp_before = cdp_target.read_text(encoding="utf-8")
    cdp_rc = apply_cdp_patch(cdp_target)
    print(f"[check] cdp_patch_rc={cdp_rc}")
    if cdp_rc != 0:
        return 2

    publish_rc = apply_publish_patch(publish_target)
    print(f"[check] publish_patch_rc={publish_rc}")
    if publish_rc != 0:
        cdp_after = cdp_target.read_text(encoding="utf-8")
        if cdp_after != cdp_before:
            cdp_target.write_text(cdp_before, encoding="utf-8")
            print(f"[rollback] 已恢复本轮 CDP 修改: {cdp_target}")
        return 2
    return 0




if __name__ == "__main__":
    raise SystemExit(main())