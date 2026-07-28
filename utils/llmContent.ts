/**
 * LLM 返回体的安全取词。
 *
 * 背景：全仓十几处 `data.choices[0].message.content.xxx` 裸链——网关返回
 * 200 + `{error:...}`、空 choices、被 CF 拦截返回 HTML 时，用户看到的是
 * `Cannot read properties of undefined` 天书。这里统一收口：
 * 取不到就抛一条带上游错误信息的人话异常，调用方现有 catch 能直接展示。
 */
export function extractLlmContent(data: any): string {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.length > 0) return content;
    // reasoning 模型可能把正文放 reasoning_content（少见，但兜一手）
    const reasoning = data?.choices?.[0]?.message?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) return reasoning;
    const upstream = data?.error?.message || data?.error?.code || data?.message;
    throw new Error(upstream ? `API 返回错误：${upstream}` : 'API 返回格式异常（没有 choices[0].message.content）');
}
