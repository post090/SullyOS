/**
 * 聊天语音条：合成完要不要立刻响。
 *
 * 两条规则各有来由，别合并简化：
 *  - AI 自动发来的语音（收到消息就顺手合成的），默认**不**自动播。用户不一定方便听声，
 *    语音条会照常出现，想听点一下就是了。角色开了「收到就自动播放」才恢复合成即播。
 *  - 用户主动要的语音（长按「转换语音」、点还没合成的空语音条），无论开关怎么设都播——
 *    他点这一下的意思就是「我现在要听」，还要再点一次播放属于白跑一趟。
 */
export function shouldAutoPlayGeneratedVoice(opts: {
  /** 这次合成是 AI 消息到达后自动触发的（false = 用户主动点的） */
  autoTriggered: boolean;
  /** 角色的「收到就自动播放」开关，未设置视作关 */
  autoPlayEnabled?: boolean;
}): boolean {
  if (!opts.autoTriggered) return true;
  return !!opts.autoPlayEnabled;
}
