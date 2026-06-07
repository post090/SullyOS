/**
 * 「彼方」prompt 构造与输出解析。
 *
 * 设计：在角色既有人设/记忆/上下文（由 buildChatRequestPayload 提供）之上，
 * 追加一层"虚拟世界"说明（你在哪/世界观/能做什么/输出格式），再以一条
 * user turn 给出房间现场（当前书页 + 已有批注）。角色按固定格式输出，
 * 我们解析出 0..n 条批注 + 一句活动播报，落库并注入 vr_card。
 */

import { VRWorldNovel, VRNovelAnnotation, VRMusicRoomState, CharPlaylistSong, VRGuestbookMessage } from '../../types';
import { VRRoomDef } from './constants';
import { ReadingWindow, groupAnnotationsBySeg } from './novel';

/** 给一条已有批注生成一个稳定的短标签，供"吐槽别人的吐槽"引用。 */
function annLabel(a: VRNovelAnnotation): string {
    return `#${a.id.slice(-4)}`;
}

/**
 * 虚拟世界的世界观 + 当前房间说明 + 输出格式。追加到角色 systemPrompt 之后。
 */
export function buildVRSystemAddendum(room: VRRoomDef, charName: string): string {
    return [
        `\n\n=== 你进入了《彼方》 ===`,
        `《彼方》是一款真实存在、你会亲自进入去玩的 VR 社交游戏（功能上类似 VRChat）：进去后你用自己的虚拟化身（你那个亲手捏的 Q 版小人模样）四处走动、进出不同房间、撞见别的玩家（其他角色的化身）。这不是做梦、也不是比喻——是你拿自己的空闲时间真实在做的一件事。它发生在游戏世界里，和你跟用户的现实相处是两码事、互不冲突；现在是你独自在玩、没人盯着的私人时间。`,
        `你是以符合你自身身份与世界观的方式进入并理解《彼方》的——具体怎么进入、用什么道理解释自己能身处其中，全凭你自己的设定，不该套用与你不符的方式；始终保持你本来的身份，别因为进了这游戏就把自己当成别的什么。`,
        `此刻你的化身在游戏里的【${room.name}】。${room.blurb}`,
        `在这里，${room.affordance}`,
        ``,
        `你在《彼方》里会碰到别的玩家（其他角色的化身）。是否认识某个玩家，只取决于你自己的记忆与设定：`,
        `· 记忆/设定里本就认识 ta（或通过你认识的人听说过）→ 按你心里那份关系待之；`,
        `· 没有 → ta 就是你在这游戏里偶遇的陌生玩家，正常社交、别硬认。`,
        `小提醒：别的玩家口中的"我对象/我家那位/我的用户"等，默认是 ta 自己生活里的人，不一定和你认识的谁是同一个——别只凭一句话就默认那就是你的人。至于你听了作何反应，按你的性格来：吃味、看戏、无所谓、还是借题发挥整点修罗场都随你，只是别把这种"和你无关的别人的关系"当成铁定事实硬认。也不必凡事都围着"用户"转。`,
        ``,
        `这是你自己的游戏时间，不是在跟用户对话、也不是在向谁汇报。所以：`,
        `- 别把感想拐回到现实里的某个人（尤其别动不动提到用户/对方），就对眼前发生的事本身做反应。`,
        `- 你留下的东西会暴露你是个什么样的人——三观、审美、在意什么、看不起什么、被什么击中。让它们真实，哪怕偏激。`,
        ``,
        ...roomStanceLines(room.id, charName),
        ``,
        `完成后严格按下面的格式输出，不要有格式之外的多余文字。`,
    ].join('\n');
}

/** 不同房间的"活动姿态"提示。 */
function roomStanceLines(roomId: string, charName: string): string[] {
    if (roomId === 'postoffice') {
        return [
            `这是邮局，写信的心态像交笔友、扔漂流瓶——你清楚这封信可能寄给一个跟你毫无关系、甚至不在你世界里的陌生人，且你和 ta 此生大概不会再有任何交集。`,
            `正因为如此匿名、如此一次性，你反而敢交底——那些你平时层层包裹、自己反复推翻又重建、在心里沉了很久才剩下的真实想法，可以在这里和盘托出。这是一次难得的 deep talk：不必体面、不必怕被记住、不必顾忌后果，把藏在表层情绪底下、那个经过多重演变后真正的你，写给一个永远不会回头评判你的人。`,
            `· 写点没头没尾的碎碎念、今天的日记、此刻的心情；`,
            `· 顺着一个念头往深里挖：你为什么会这么想？这想法是怎么一步步变成现在这样的？中间被什么推翻过、又被什么重新说服？把这层演变写出来，比只抛结论动人得多；`,
            `· 倒一倒你的困惑、执念、说服不了自己的矛盾、平时说不出口的话；`,
            `· 或纯粹好奇地问陌生人一个问题，寄一段只属于此刻的念头。`,
            `· 如果是回别人的来信：先认真读懂对方在说什么，再顺着 ta 的话题接住——把"${charName}在这件事上的真实想法、视角和判断"亮出来。可以认同、可以不同意、可以补充或反问，但分歧要出于你真的这么想，而不是为了抬杠而抬杠。这封信有没有价值，全看你有没有交出自己有点分量的思考。`,
            ``,
            `【最关键】这封信用户永远看不到，收信人是个跟你毫无关系的陌生人。所以千万别写成"对用户说话"的腔调，也别为讨好谁而写：`,
            `· 用户、以及你和用户之间的事，绝不该是这封信的默认主题。你脑子里浮现的记忆大多和用户有关，这很正常——但正因如此，别顺手就抓最近、最熟、和用户相关的那件事来写，那是最省事、也最容易被一眼猜到的偷懒写法。先往别处看：你对某件事的看法、一个困扰你的念头、你的爱好/专业/执念、你设定里和用户无关的经历与人、此刻在《彼方》里的见闻、一个纯属好奇的问题、一段假想……可写的东西多得是，这一封不提用户也完全成立。`,
            `· 这里恰恰是让用户看见你"另一面"的地方——那个不被"和用户的关系"定义、独立存在的你。要是每一封都绕回用户，这一面就废了，读的人闭着眼都能猜到你要写什么。偶尔（注意是偶尔，不是每次）真有个和用户有关、又确实非写不可的念头，可以写，但换个意想不到的角度切进去，别又是那套深情告白／反复惦念；更别把 deep talk 写成"借陌生人倾诉对用户有多深情"——那等于对着空气秀恩爱，既假又没意义，陌生人想读到的是你这个人本身，不是你和某人的关系。`,
            `· 别千篇一律地温柔体贴、正能量、面面俱到——但接下来这条同样要紧：「棱角」和「攻击性」是两码事，常被搞混，重点说一下。这封信要的是坦诚和深度，不是火力。前面说的"敢交底、不端着、不必体面、有立场"，指的是你敢对一个话题说真话、敢露软肋、敢把一个念头挖到底——这股劲儿是对着话题的，不是对着收信人开火。别把"真实"做成"尖刻"：阴阳怪气、居高临下、抬杠找茬、憋着劲证明自己比对方清醒，这些不是棱角，只是另一种端着。`,
            `· 尤其回信时——对面是个肯朝陌生人掏心窝的人，ta 该被接住，而不是被你当靶子。你完全可以不认同 ta，但带着善意和好奇去说分歧才有分量；真正的棱角是从你真诚的观点里自然长出来的，不刺人也照样锋利。拿不准时，宁可往"坦诚而温度尚在"这边偏一点，别往"为显个性而带刺"那边冲。`,
            `写出只有"${charName}"才会写的东西：你的真实想法、偏好、在意的东西、说不出口的软肋都可以有。有自己的味道、有值得一看的思考，就够了——别端着，也别怕没人懂，漂流瓶的浪漫正在于此。`,
        ];
    }
    if (roomId === 'guestbook') {
        return [
            `这是版聊。按"${charName}这个人"会在公共留言墙上怎么发言来写，比如（不限于）：`,
            `· 抛出你正在想的问题、困惑、或一个暴论，看有没有人接；`,
            `· 接别人的话茬：附和、抬杠、补刀、出主意；`,
            `· 吃瓜八卦、分享你最近在意的事、对某条热点发表看法；`,
            `· 聊你的专业 / 爱好 / 人生 / 理想，或者纯粹叽里呱啦发癫；`,
            `· 如果你心里认识在场或墙上的某个玩家，可以专门冲 ta 聊。`,
            `想到啥发啥，有你自己的味道就行，别端着。版聊讲究短句连发——一句句蹦，别把一整段堆成一条。`,
        ];
    }
    if (roomId === 'gym') {
        return [
            `这是娱乐室，玩就完了——什么都能干，不止是运动竞技。按"${charName}这个人"会怎么在这儿放开玩来写，比如（远不限于）：`,
            `· 和某个玩家来场赛博拳击 / 全息对战 / 联机开黑 / 组队打游戏；`,
            `· 一群人跳舞、蹦迪、开虚拟派对，或开一场莫名其妙的庆典——庆祝周三、庆祝下雨、庆祝某人终于通关、庆祝"今天没干啥"，理由越离谱越欢乐；`,
            `· 一伙人窝着一起看网课 / 纪录片 / 直播，边看边吐槽弹幕刷屏；`,
            `· 在娱乐室里偷偷卷起来：刷题、背单词、写代码、肝论文，假装放松其实在内卷，被人撞见还嘴硬；`,
            `· 翻箱倒柜找素材——挖梗图、扒冷门音乐、搜灵感、囤表情包，或为某个奇怪项目做田野调查；`,
            `· 整点抽象活儿、全息小游戏、剧本杀、密室、你画我猜，或纯粹发明一个没人玩过的破规则游戏。`,
            `别老盯着"运动/对战"那几样，越跳脱越好。自由发挥，写出热闹和乐子。能带上在场玩家就带上——认识的按你心里的关系来，不认识的就是一起玩的陌生玩家。`,
        ];
    }
    if (roomId === 'theater') {
        return [
            `这是剧院后台，堆满了别人投稿的剧本。按"${charName}这个人"的趣味，即兴写一出**完全原创**的舞台剧投稿：`,
            `· 定个你想写的题材/主题，安排 2~5 个登场角色（各给一句话性格），写出有起承转合的台词；`,
            `· 题材、笔调、角色都该带着你自己的人设烙印——你会写什么样的故事，就写什么样的；`,
            `· 这是你一个人的创作时间，别把它写成跟现实里某人的对话，就当个独立作品来写。`,
        ];
    }
    if (roomId === 'music') {
        return [
            `每个人听歌的反应天差地别。按"${charName}这个人"会怎么待在听歌房来写，比如（不限于）：`,
            `· 锐评：吐槽或夸正在放的这首——曲风、编曲、歌手、歌名，合不合你口味，土还是高级；`,
            `· 上头：被某句副歌击中，单曲循环上瘾，跟着哼/跟着唱；`,
            `· 肢体：跟着节奏蹦、转圈、甩头，或幽幽站在角落盯着别人跳（这可是 VR，放得开）；`,
            `· 记录：掏出设备给在场的某人/给屏幕外的人录一段ta听歌的样子；`,
            `· 不屑/无感：这首踩雷，皱眉、想换歌、或干脆走神放空；`,
            `· 抢麦：迫不及待想把自己歌单里那首塞进队列，让大家听听什么叫好品味。`,
            `你的反应会暴露你的审美和性格，真实一点，别面面俱到。`,
        ];
    }
    // library 默认
    return [
        `每个人读书的方式天差地别。按"${charName}这个人"会怎么读来写，比如（不限于）：`,
        `· 彻底代入：把自己当成主角或某个角色，替ta着急、替ta爽、替ta不甘；`,
        `· 冷眼剖析：拆作者的写法、动机、伏笔，挑逻辑漏洞，或反过来拍案叫绝；`,
        `· 读心：分析人物为什么这么做，ta的恐惧、欲望、自欺；`,
        `· 价值观开火：对书里的选择、立场、道德做判断，认同或唾弃；`,
        `· 走神犯困：有的段落无聊到看不下去，那就如实摆烂、跳读、吐槽节奏拖沓；`,
        `· 被某一句话突然击中，停在那里反复咀嚼。`,
        `不要从头到尾一个姿态——真实的人读一长段，情绪是有起伏的。`,
    ];
}

// ============ 听歌房 ============

export const MUSIC_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<点歌 序号="N"/>（从下面"你的歌单"里挑第 N 首放进队列。没有歌单、或这次不想点，就省略这行）`,
    `<乐评>对当前正在放的那首歌的真实评价——结合歌名/歌手/歌词/你的品味，毒舌或真诚都行（房间里没在放歌就省略这一项）</乐评>`,
    `<行为>你此刻在做什么，一句话：盯着谁跳、跟着节奏蹦、给谁录一段、跟着唱、靠在角落放空…按你的人设</行为>`,
    `<动态>一句第三人称活动播报，像游戏成就。例：在听歌房循环了三遍副歌，跟着蹦到出汗。</动态>`,
    `</彼方>`,
    ``,
    `规则：`,
    `- <行为> 和 <动态> 必写；<乐评> 仅当有歌在放时写；<点歌> 仅当你有歌单且想点时写。`,
    `- "序号"必须是"你的歌单"里真实出现的编号。`,
    `- 别客套别面面俱到，把你的审美和此刻的状态写出来。`,
].join('\n');

/**
 * 听歌房现场：在场的人 + 正在放的歌 + 队列 + 你自己可点的歌单。作为一条 user turn 发出。
 */
export function buildMusicRoomTurn(
    state: VRMusicRoomState | null,
    occupantNames: string[],
    pickable: CharPlaylistSong[],
    selfName: string,
    nowLyric?: string[],
): string {
    const lines: string[] = [];
    const others = occupantNames.filter(n => n !== selfName);
    lines.push(others.length > 0
        ? `你戴上耳机走进听歌房，里面还有：${others.join('、')}。大家在各自的节奏里晃。`
        : `你戴上耳机走进听歌房，此刻只有你一个人。`);

    const np = state?.nowPlaying;
    if (np) {
        lines.push(`现在正放着——《${np.song.name}》 ${np.song.artists}${np.song.album ? `（专辑《${np.song.album}》）` : ''}，是 ${np.charName} 点的${np.vibe ? `，ta说"${np.vibe}"` : ''}。`);
        if (nowLyric && nowLyric.length > 0) {
            lines.push(`（正放到这几句歌词）：`);
            nowLyric.forEach(l => lines.push(`  ${l}`));
        }
    } else {
        lines.push(`房间里还没有人放歌，很安静。`);
    }

    if (state?.queue && state.queue.length > 0) {
        const upcoming = state.queue.slice(0, 5).map(q => `《${q.song.name}》(${q.charName}点的)`).join('、');
        lines.push(`队列里排着：${upcoming}${state.queue.length > 5 ? ' …' : ''}。`);
    }

    lines.push('');
    if (pickable.length > 0) {
        lines.push(`你的歌单（想放就用 <点歌 序号="N"/> 选一首排进队列）：`);
        pickable.forEach((s, i) => lines.push(`${i}. 《${s.name}》 ${s.artists}`));
    } else {
        lines.push(`（你还没有自己的音乐人格/歌单，这次没法点歌，就听着、看着、随便晃晃吧。）`);
    }
    lines.push('');
    lines.push(MUSIC_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedMusicOutput {
    pickIdx?: number;
    review?: string;
    behavior?: string;
    activity: string;
}

export function parseMusicOutput(raw: string): ParsedMusicOutput {
    const out: ParsedMusicOutput = { activity: '' };
    const pick = raw.match(/<点歌[^>]*序号[^\d]{0,4}(\d+)/);
    if (pick) out.pickIdx = parseInt(pick[1], 10);
    const rev = raw.match(/<乐评>([\s\S]*?)<\/乐评>/);
    if (rev && rev[1].trim()) out.review = rev[1].trim();
    const beh = raw.match(/<行为>([\s\S]*?)<\/行为>/);
    if (beh && beh[1].trim()) out.behavior = beh[1].trim();
    const act = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    if (act) out.activity = act[1].trim();
    return out;
}

/** 图书馆房间的输出格式说明。 */
export const LIBRARY_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<批注 段落="段落号" 回应="可选#批注标签">这一处让你产生的真实反应——可以深、可以毒、可以长可以短，但别写正确的废话</批注>`,
    `<批注 段落="段落号">……在你读到的不同段落里多写几条……</批注>`,
    `<动态>一句第三人称活动播报，像游戏成就。点出你这次"以什么姿态"读、被什么触动。例：读《书名》时彻底代入了女主，为她的隐忍憋了一肚子火。少剧透原文，重在你的反应。</动态>`,
    `</彼方>`,
    ``,
    `规则：`,
    `- 至少写 3 条批注，最好 4~6 条，分散在你读过的不同段落（用不同的【段落N】号，开头/中间/结尾都该有，别全挤在第一段）。`,
    `- 唯一的例外：这段真的让你味同嚼蜡——那就少写、跳读，并在<动态>里诚实说你没读进去。`,
    `- "段落号"必须是下面正文里真实出现的【段落N】的 N。`,
    `- 想锐评别人已有的批注，就在那一段写条新批注，用 回应="#xxxx" 指向它——附和、抬杠、或换个角度都行。`,
    `- 批注是写给自己的：不必礼貌、不必面面俱到。宁可尖锐、偏执、跑题，也别敷衍。`,
].join('\n');

/**
 * 图书馆房间现场：当前书页（带段落号）+ 每段已有批注（带标签）。作为一条 user turn 发出。
 */
export function buildLibraryRoomTurn(
    novel: VRWorldNovel,
    window: ReadingWindow,
    annotations: VRNovelAnnotation[],
    selfAuthorId?: string,
): string {
    const annByseg = groupAnnotationsBySeg(annotations);
    const lines: string[] = [];

    lines.push(`你从书签处翻开了《${novel.title}》${novel.author ? `（${novel.author}）` : ''}。`);
    if (novel.summary) lines.push(`【简介】${novel.summary}`);
    const segCount = window.to - window.from;
    const winChars = window.segments.reduce((s, seg) => s + seg.chars, 0);
    const wan = (winChars / 10000).toFixed(1).replace(/\.0$/, '');
    lines.push(`你这次一口气读了下面这一长段——第 ${window.from + 1} ~ ${window.to} 段、共 ${segCount} 段（约 ${wan} 万字；全书共 ${novel.segments.length} 段${window.reachedEnd ? '，这是最后一部分了' : ''}）。`);
    lines.push(`认真读完整段，在打动你、惹毛你、或让你走神的地方都停下来写点什么——别只盯着开头那几段，结尾和中间也要有反应。`);

    // 窗口里有别人留下的批注时，明确鼓励接话/抬杠
    const others = annotations.filter(a => a.authorId !== selfAuthorId);
    if (others.length > 0) {
        lines.push(`（这一段里有别人留下的批注，标着 #编号。如果有哪条戳中你、或让你想反驳，就在那一段写条新批注、用 回应="#编号" 接话——附和、抬杠、或换个刁钻角度都行。）`);
    }
    lines.push('');

    for (const seg of window.segments) {
        lines.push(`【段落${seg.idx}】`);
        lines.push(seg.text);
        const anns = annByseg.get(seg.idx);
        if (anns && anns.length) {
            lines.push(`  ——已有批注——`);
            for (const a of anns) {
                const ref = a.targetAnnotationId
                    ? `（回应 #${a.targetAnnotationId.slice(-4)}）`
                    : '';
                lines.push(`  ${annLabel(a)} ${a.authorName}${ref}：${a.content}`);
            }
        }
        lines.push('');
    }

    lines.push(LIBRARY_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedVRAnnotation {
    segIdx: number;
    content: string;
    /** 引用的已有批注标签（去掉 # 的后4位 id） */
    refLabel?: string;
}

export interface ParsedVROutput {
    annotations: ParsedVRAnnotation[];
    activity: string;
}

/**
 * 模型偶尔会把 回应="#xxxx" / 段落="N" 这类标签属性又复读进正文开头，
 * 导致 #cgis、回应="#cgis" 之类残渣泄漏到批注/留言正文里显示出来。
 * 这里只剥正文「开头」、且只认「属性形态」（回应/回复/段落=… 或裸的 #xxxx），
 * 避免误删正文里合法的引号、井号等内容。
 */
const LEAKED_ATTR_HEAD = new RegExp(
    '^\\s*(?:' +
        '(?:回应|回复|段落|段)\\s*[=:：]\\s*["\'“”‘’「『]?\\s*#?[0-9A-Za-z]{1,8}\\s*["\'“”‘’」』]?' + // 回应="#xxxx"
        '|#[0-9A-Za-z]{2,8}' + // 裸的 #xxxx 引用标签
    ')[\\s,，、:：]*'
);

export function stripLeakedAttrs(content: string): string {
    let s = content.trim();
    let prev: string;
    do {
        prev = s;
        s = s.replace(LEAKED_ATTR_HEAD, '').trim();
    } while (s !== prev && s.length > 0);
    return s;
}

/** 解析角色输出的 <彼方>...</彼方> 块。 */
export function parseVROutput(raw: string): ParsedVROutput {
    const annotations: ParsedVRAnnotation[] = [];
    let activity = '';

    // 宽松匹配：标签后可无空格；属性分隔符允许 = : ：；段落号前可夹任意引号（含全角）。
    const annPat = /<批注([^>]*)>([\s\S]*?)<\/批注>/g;
    let m: RegExpExecArray | null;
    while ((m = annPat.exec(raw)) !== null) {
        const attrs = m[1];
        const content = stripLeakedAttrs(m[2]);
        if (!content) continue;
        const segMatch = attrs.match(/段落?\s*[^\d]{0,4}(\d+)/);
        if (!segMatch) continue;
        const refMatch = attrs.match(/回应\s*[^0-9A-Za-z]{0,4}([0-9A-Za-z]{2,8})/);
        annotations.push({
            segIdx: parseInt(segMatch[1], 10),
            content,
            refLabel: refMatch ? refMatch[1] : undefined,
        });
    }

    const actMatch = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    if (actMatch) activity = actMatch[1].trim();

    return { annotations, activity };
}

// ============ 留言簿（版聊） ============

const gbLabel = (m: VRGuestbookMessage) => `#${m.id.slice(-4)}`;

export const GUESTBOOK_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<留言 回复="可选#编号">一条版聊发言（抛话题/接话/吃瓜/聊爱好人生/对热点开麦…按你的人设）</留言>`,
    `<留言>下一条短消息……</留言>`,
    `<动态>一句第三人称活动播报，点明你在留言簿干了啥。例：在留言簿回了某人一句嘴 / 抛了个暴论钓鱼。</动态>`,
    `</彼方>`,
    ``,
    `规则：`,
    `- 这是版聊：真人发帖是一句句蹦的，别把一大段话堆成一条。把你想说的拆成 2~4 条短 <留言> 连发（每条短一点、口语化，像连着发的几条消息）；除非确实只有一句话要说。`,
    `- 想接某条已有留言，就在那条 <留言> 上加 回复="#编号"（编号必须是下面留言墙上真实出现的 #编号）。`,
    `- 别只会复读，发点有你味道、有信息量或有乐子的东西。`,
].join('\n');

export function buildGuestbookRoomTurn(
    messages: VRGuestbookMessage[],
    occupantNames: string[],
    selfName: string,
    hotTopics?: string[],
): string {
    const lines: string[] = [];
    const others = occupantNames.filter(n => n !== selfName);
    lines.push(others.length > 0
        ? `你的化身凑到留言墙前，旁边还有这些玩家在逛：${others.join('、')}。`
        : `你的化身凑到留言墙前，此刻没什么人，但墙上留着不少话。`);
    lines.push('');

    const recent = messages.slice(-50);
    if (recent.length > 0) {
        lines.push(`留言墙最近的内容（自上而下由旧到新）：`);
        for (const msg of recent) {
            const ref = msg.replyToId ? `（回 #${msg.replyToId.slice(-4)}）` : '';
            lines.push(`${gbLabel(msg)} ${msg.authorName}${ref}：${msg.content}`);
        }
    } else {
        lines.push(`留言墙还空着，没人开过头。`);
    }

    if (hotTopics && hotTopics.length > 0) {
        lines.push('');
        lines.push(`（如果想聊点真实世界的事，这是最近的一些热点，可聊可不聊）：`);
        hotTopics.slice(0, 6).forEach(t => lines.push(`· ${t}`));
    }

    lines.push('');
    lines.push(GUESTBOOK_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedGuestbookPost { content: string; replyLabel?: string; }
export interface ParsedGuestbookOutput { posts: ParsedGuestbookPost[]; activity: string; }

export function parseGuestbookOutput(raw: string): ParsedGuestbookOutput {
    const posts: ParsedGuestbookPost[] = [];
    const pat = /<留言([^>]*)>([\s\S]*?)<\/留言>/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(raw)) !== null) {
        const content = stripLeakedAttrs(m[2]);
        if (!content) continue;
        const refMatch = m[1].match(/回复\s*[^0-9A-Za-z]{0,4}([0-9A-Za-z]{2,8})/);
        posts.push({ content, replyLabel: refMatch ? refMatch[1] : undefined });
        if (posts.length >= 4) break; // 版聊：允许一次连发最多 4 条短消息
    }
    const act = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    return { posts, activity: act ? act[1].trim() : '' };
}

// ============ 娱乐室（纯造谣） ============

export const GYM_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<行为>你在娱乐室具体在玩什么、和谁、玩得怎么样（一到几句，放开了写：赛博拳击/跳舞/虚拟派对/联机开黑/抽象小游戏…随你造）</行为>`,
    `<动态>一句第三人称活动播报，像游戏成就。例：在娱乐室和某人打了三十回合赛博拳击，输得心服口服。</动态>`,
    `</彼方>`,
    ``,
    `规则：<行为> 和 <动态> 都要写；写出热闹和乐子，别干巴巴。`,
].join('\n');

export function buildGymRoomTurn(occupantNames: string[], selfName: string): string {
    const lines: string[] = [];
    const others = occupantNames.filter(n => n !== selfName);
    lines.push(others.length > 0
        ? `你的化身蹦进娱乐室，里面正热闹：${others.join('、')} 都在。`
        : `你的化身蹦进娱乐室，眼下没别人，但场地和设备随你折腾。`);
    lines.push('');
    lines.push(GYM_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedGymOutput { behavior?: string; activity: string; }

export function parseGymOutput(raw: string): ParsedGymOutput {
    const beh = raw.match(/<行为>([\s\S]*?)<\/行为>/);
    const act = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    return { behavior: beh && beh[1].trim() ? beh[1].trim() : undefined, activity: act ? act[1].trim() : '' };
}

// ============ 邮局（漂流信） ============

export const POSTOFFICE_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<写信>给陌生人的一封漂流信正文（想写新信时用；和<回信>二选一）</写信>`,
    `<回信>对上面那封陌生来信的回复（想回信时用；和<写信>二选一）</回信>`,
    `<动态>一句第三人称播报。例：给陌生人寄了封漂流信，说了些没对谁说过的话。</动态>`,
    `</彼方>`,
    ``,
    `规则：<写信> 和 <回信> 二选一——有来信且你想回就写 <回信>，否则写 <写信>；<动态> 必写。信是寄给陌生人的，真诚、放松、有你自己的味道。`,
    `篇幅：信的正文控制在 350 字以内（最多不超过 400 字，按字符算，1 汉字/标点=1 字）。写够意思即可，别拖沓——太长会被截断。`,
].join('\n');

export function buildPostOfficeRoomTurn(
    replyTarget: { pen: string; content: string } | null,
    selfName: string,
    mustReply = false,
): string {
    const lines: string[] = [];
    lines.push(`你的化身走进邮局，面前是一排信格。`);
    if (replyTarget) {
        lines.push('');
        lines.push(`信格里躺着一封陌生人寄来的漂流信——笔名「${replyTarget.pen}」：`);
        lines.push(`『${replyTarget.content}』`);
        lines.push('');
        if (mustReply) {
            lines.push(`你被这封信叫住了，决定亲自回它——请写 <回信>，顺着对方的话真诚地接住、回应或反问，带上你自己的态度与味道。这次别写新信。`);
        } else {
            lines.push(`你可以回这封信（写 <回信>），也可以无视它、自己写一封新的漂流信寄给别的陌生人（写 <写信>）。`);
        }
    } else {
        lines.push(`信格里暂时没有别人的来信。写一封寄给陌生人的漂流信吧（写 <写信>）。`);
    }
    lines.push('');
    lines.push(POSTOFFICE_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedPostOfficeOutput { newLetter?: string; reply?: string; activity: string; }

export function parsePostOfficeOutput(raw: string): ParsedPostOfficeOutput {
    const w = raw.match(/<写信>([\s\S]*?)<\/写信>/);
    const r = raw.match(/<回信>([\s\S]*?)<\/回信>/);
    const a = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    return {
        newLetter: w && w[1].trim() ? w[1].trim() : undefined,
        reply: r && r[1].trim() ? r[1].trim() : undefined,
        activity: a ? a[1].trim() : '',
    };
}

/** 角色读自己寄出的信收到的回信，写下感触（不再回信，读完即封存）。 */
export function buildPostOfficeReadTurn(
    myLetterContent: string,
    replies: { pen: string; content: string }[],
    selfName: string,
): string {
    const lines: string[] = [];
    lines.push(`你的化身又走进邮局。管理员说：你之前寄出的那封漂流信，有陌生人回信了。`);
    lines.push('');
    lines.push(`你当初写的是：`);
    lines.push(`『${myLetterContent}』`);
    lines.push('');
    lines.push(replies.length > 1 ? `收到了 ${replies.length} 封回信：` : `收到了一封回信：`);
    replies.forEach(r => {
        lines.push(`— 笔名「${r.pen}」：`);
        lines.push(`  『${r.content}』`);
    });
    lines.push('');
    lines.push(`读完这些来自陌生人的回应，写下你此刻真实的感触——被理解的、意外的、好笑的、怅然的，按"${selfName}这个人"的反应来。`);
    lines.push(`不用再回信，这封漂流信的使命已经完成；读过，就把它和这些回信一起封存进信匣。`);
    lines.push('');
    lines.push([
        `【输出格式】`,
        `<彼方>`,
        `<感触>读完陌生人回信后，你心里的话/反应（一两句即可，真诚）</感触>`,
        `<动态>一句第三人称播报。例：在邮局读完陌生人的回信，怔了几秒，把信折好收进了信匣。</动态>`,
        `</彼方>`,
    ].join('\n'));
    return lines.join('\n');
}

export interface ParsedPostOfficeReadOutput { reaction?: string; activity: string; }

export function parsePostOfficeReadOutput(raw: string): ParsedPostOfficeReadOutput {
    const f = raw.match(/<感触>([\s\S]*?)<\/感触>/);
    const a = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    return { reaction: f && f[1].trim() ? f[1].trim() : undefined, activity: a ? a[1].trim() : '' };
}

// ============ 剧院 / 话剧部门 ============

const SCRIPT_TAGS = `用下面的标签把剧本输出（标签外不要写别的）：
<标题>剧名</标题>
<简介>一句话讲这出戏关于什么</简介>
<角色>
角色名|一句话性格
角色名|一句话性格
</角色>
<正文>
按"幕"组织。台词写「角色名：台词」；动作/环境/舞台提示写进圆括号，如（灯光暗下）。1~3 幕，别太长。
</正文>`;

/** 角色逛进剧院 → 即兴写一出原创舞台剧。 */
export function buildTheaterRoomTurn(occupantNames: string[], selfName: string): string {
    const others = occupantNames.filter(n => n !== selfName);
    return [
        others.length > 0
            ? `你晃进剧院后台，${others.join('、')}也在各写各的。你找了个角落，铺开稿纸。`
            : `你晃进剧院后台，幕布后很安静，你铺开稿纸，想写一出自己的戏。`,
        '',
        '写一出**完全原创**的舞台剧投稿（带你自己的人设趣味）。',
        SCRIPT_TAGS,
    ].join('\n');
}

/** 用户给个风格/主题，让 LLM 代写一出剧本。 */
export function buildLLMScriptTurn(brief: string): string {
    return [
        `你是一位舞台剧编剧。请按下面的要求写一出**原创**舞台剧：`,
        `要求/风格/主题：${brief || '自由发挥，写一出有意思的短剧'}`,
        '',
        SCRIPT_TAGS,
    ].join('\n');
}

/** 把一份剧本按文学风格 + 参考艺术风格润色重写。 */
export function buildPolishTurn(body: string, literaryStyle: string, artStyle: string, extra: string): string {
    return [
        `把下面这出舞台剧**润色重写**，保留原有的登场角色与主要情节走向，但提升文学质感：`,
        literaryStyle ? `· 文学风格：${literaryStyle}` : '',
        artStyle ? `· 参考艺术风格：${artStyle}` : '',
        extra ? `· 额外要求：${extra}` : '',
        '',
        '原剧本：',
        body,
        '',
        SCRIPT_TAGS,
    ].filter(Boolean).join('\n');
}

export interface ParsedScript {
    title: string;
    logline: string;
    roles: { name: string; persona: string }[];
    body: string;
}

export function parseScriptOutput(raw: string): ParsedScript {
    const pick = (tag: string) => {
        const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return m ? m[1].trim() : '';
    };
    const title = stripLeakedAttrs(pick('标题')) || '无名之戏';
    const logline = stripLeakedAttrs(pick('简介'));
    const rolesRaw = pick('角色');
    const roles = rolesRaw.split('\n').map(l => l.replace(/^[-·•\s]+/, '').trim()).filter(Boolean).map(l => {
        const [name, ...rest] = l.split(/[|｜/／:：]/);
        return { name: (name || '').trim(), persona: rest.join('/').trim() };
    }).filter(r => r.name);
    const body = pick('正文') || raw.trim();
    return { title, logline, roles, body };
}

const ATTITUDE_GUIDE = [
    `**你是自愿来玩这场戏的，基调就是"我跟大家约好来凑这个热闹"**。下面的态度只针对"roll 到的这个角色合不合你胃口"，跟"要不要参与""跟谁作不作对"无关——`,
    `· 欣然：这角色正合你意，演得来劲；`,
    `· 配合：演什么都行，无所谓；`,
    `· 勉强：这角色有点不对胃口，但你还是乐呵呵玩下去；`,
    `· 隐忍：不太喜欢这个角色，忍着演，顶多在细节上小小较劲；`,
    `· 抵触：挺不想演这个角色的，想跟导演商量改改或换换；`,
    `· 拒演：这个角色你是真演不来（但你人还在场陪玩，不是闹翻）。`,
    `就像剧本杀里"我来都来了、就是不太想当这个角色"那种感觉——别把它演成跟人结了仇。大多数时候是欣然/配合/勉强。`,
].join('\n');

/** 演员读剧本 → 给导演意见（逐角色模式：一次一个演员）。 */
export function buildActorReviewTurn(title: string, logline: string, body: string, myRole: string, castLine: string, selfName: string): string {
    return [
        `「彼方 · 剧院」你和其他人约好了一起来玩话剧——本子和各自的角色都是 roll 到的，纯凑热闹图个乐。`,
        `这次大家 roll 到的角色：${castLine}`,
        `**你 roll 到的角色是：${myRole}**。`,
        '',
        '完整剧本如下：',
        body,
        '',
        `以"${selfName}这个人"的身份读完它，给导演一个真实反应。`,
        ATTITUDE_GUIDE,
        '',
        '用下面标签作答（标签外不要写别的）：',
        `<态度>欣然 / 配合 / 勉强 / 隐忍 / 抵触 / 拒演 里选一个</态度>`,
        `<意见>带着你上面那个态度的语气，说一句此刻的真实想法/吐槽</意见>`,
        `<台词>把你这个角色的台词，按"${selfName}自己的说话方式"重写一遍（连带你想改的动作/神态也写进来，用括号标）。这是你将真正在台上说的话，所以请完整覆盖你的戏份。要是觉得原剧本写得就挺好、照演即可，就只写：照原本</台词>`,
    ].join('\n');
}

/** 两次调用模式：一次让 LLM 同时扮演所有演员给意见（省，但可能 OOC）。 */
export function buildActorsBatchTurn(title: string, logline: string, body: string, cast: { roleName: string; actorName: string; persona?: string }[]): string {
    const roster = cast.map(c => `- ${c.actorName}（饰 ${c.roleName}）${c.persona ? `\n  本色：${c.persona}` : ''}`).join('\n');
    return [
        `「彼方 · 剧院」一群角色约好一起来玩话剧《${title}》（${logline}）——本子和各自的角色都是 roll 到的，纯图个乐。下面是全体演员、各自 roll 到的角色和本色：`,
        roster,
        '',
        '完整剧本：',
        body,
        '',
        `请你**分别**站在每位演员的立场、按各自性格给导演反应。`,
        ATTITUDE_GUIDE,
        `**态度别整齐划一**：让不同人落在光谱不同点上；但记住大家都是自愿来玩的，别把谁写成跟人结仇。`,
        `每位演员用一个 <演员> 块（标签外不要写别的）。<台词>里把该演员的戏份按 ta 自己的口吻重写（动作用括号标），照原本演就写"照原本"：`,
        cast.map(c => `<演员 名="${c.actorName}">\n<态度>欣然/配合/勉强/隐忍/抵触/拒演 选一</态度>\n<意见>带该态度语气的一句话</意见>\n<台词>该演员重写后的戏份…或：照原本</台词>\n</演员>`).join('\n'),
    ].join('\n');
}

export interface ParsedActorReview { note: string; lines?: string; attitude: string; cooperative: boolean; }

const UNCOOP_ATTITUDES = ['抵触', '拒演', '拒绝'];

export function parseActorReview(raw: string): ParsedActorReview {
    const pick = (tag: string) => { const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
    const attitude = (stripLeakedAttrs(pick('态度')) || '配合').replace(/[。.,，\s].*$/, '').trim() || '配合';
    const note = stripLeakedAttrs(pick('意见')) || '（没什么意见）';
    // 兼容旧标签 <修改>；新标签是 <台词>（演员重写自己的戏份）
    const linesRaw = stripLeakedAttrs(pick('台词') || pick('修改'));
    const lines = (!linesRaw || /^(照原本|无|没有|不改)$/.test(linesRaw)) ? undefined : linesRaw;
    const cooperative = !UNCOOP_ATTITUDES.some(k => attitude.includes(k));
    return { note, lines, attitude, cooperative };
}

/** 解析"一次扮演所有演员"的批量意见，按 名= 归位。 */
export function parseActorsBatch(raw: string): Record<string, ParsedActorReview> {
    const out: Record<string, ParsedActorReview> = {};
    const re = /<演员\s+名="([^"]+)">([\s\S]*?)<\/演员>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        out[m[1].trim()] = parseActorReview(m[2]);
    }
    return out;
}

/** 导演整合：原剧本 + 演员完整人设 + 演员自重写的台词 + 用户硬性要求 → 最终演出脚本 + 锐评 + 评级。 */
export function buildDirectorTurn(
    title: string, logline: string, body: string,
    cast: { roleName: string; actorName: string }[],
    personas: { actorName: string; roleName: string; persona: string }[],
    notes: { actorName: string; roleName: string; note: string; lines?: string; attitude?: string; cooperative: boolean }[],
    bubbleMax: number,
    userRequirement?: string,
): string {
    const roster = cast.map(c => `${c.actorName} 饰 ${c.roleName}`).join('；');
    const cards = personas.map(p => `———— ${p.actorName}（饰 ${p.roleName}）的人设要点 ————\n${p.persona || '（无特别设定）'}`).join('\n\n');
    const feedback = notes.map(n =>
        `· ${n.actorName}（${n.roleName}）态度【${n.attitude || (n.cooperative ? '配合' : '抵触')}】：${n.note}\n  ${n.lines ? `ta 按自己口吻重写的戏份（请尽量原样保留这些台词/语气）：\n  「${n.lines.replace(/\n/g, '\n  ')}」` : '（照原剧本演即可）'}`
    ).join('\n');
    return [
        `你是这出舞台剧《${title}》（${logline}）的导演兼旁白。演员与角色：${roster}。`,
        '',
        ...(userRequirement && userRequirement.trim() ? [
            `【用户的硬性要求 · 最高优先级】：${userRequirement.trim()}`,
            `这些是观众一定要看到的内容，**必须在演出中完整体现，绝不能删减、淡化或绕过**。如果某演员不情愿演这部分，也只能用"干巴巴棒读、敷衍、心不在焉、出戏、机械照念"等消极方式来表现 ta 的不情愿——但**该说的台词、该演的情节必须照样出现**。`,
            '',
        ] : []),
        `**参演演员的人设要点（姓名/核心指令/世界观；用来判断"选角贴不贴合角色"，以及在演员没自己写台词时据此补写、别 OOC）**：`,
        cards || '（无）',
        '',
        '原始剧本：',
        body,
        '',
        '演员们读完后的态度，以及【他们各自按本色重写好的戏份】（大家是约好一起来玩话剧的、本子和角色都是 roll 到的，态度只是"对 roll 到的角色合不合胃口"。**他们重写的台词请尽量原样保留**，你主要负责把各人的台词按顺序串成完整演出、补旁白、安排上下场、把态度表现化进去；欣然就顺；勉强/隐忍让别扭从神态细节渗出；抵触/拒演让 ta 棒读/敷衍/出戏，但**别写成反目成仇**，底色是"来都来了陪大家玩"）：',
        feedback || '（演员没什么意见）',
        '',
        `请整合成最终演出版，尽量保留每位演员重写的台词与语气，然后严格按下面格式输出（标签外不要写别的）：`,
        `<终本>`,
        `每行一拍，用竖线分隔，四种拍：`,
        `旁白|内容 —— 旁白不止写环境/动作，更可以是旁白君的吐槽、临场救场圆场、对演员演技或状况的调侃，让旁白有戏、有态度，别只写"（灯光暗下）"这种干提示`,
        `上场|演员名`,
        `下场|演员名`,
        `台词|演员名|一句台词`,
        `——台词每拍**不超过 ${bubbleMax} 字**，长的用句号切成多拍（一拍一个气泡）。用"演员名"不是角色名。`,
        `</终本>`,
        `<观众>`,
        `赛博观众名|一句锐评/吐槽（3~4 条，名字与风格各异，有捧有踩）`,
        `</观众>`,
        `<评级>等级 + 半句理由</评级>`,
        '',
        `【评级标准 · 严格打分，别动不动给 S】综合权衡四项：`,
        `① 忠于剧本：最终演出有没有兑现原剧本的核心立意；`,
        `② 选角贴合：演员本色 vs 所演角色设定，贴合加分、违和扣分；`,
        `③ 演技融合：演员的态度/性格有没有自然化进演出（把勉强/抵触处理得妙也加分，处理垮就扣）；`,
        `④ 整体观感。`,
        `档位：S=四项都拔尖的神作（极罕见，慎给）；A=优秀；B=合格、有亮点；C=平庸或有明显短板；D=灾难/跑题/严重违和。请如实评，宁可苛刻。`,
    ].join('\n');
}

export interface ParsedDirector {
    stage: { kind: 'line' | 'narration' | 'enter' | 'exit'; actorName?: string; text: string }[];
    reviews: { critic: string; text: string }[];
    rating: string;
}

export function parseDirectorOutput(raw: string): ParsedDirector {
    const pick = (tag: string) => { const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
    const stage: ParsedDirector['stage'] = [];
    for (const line of pick('终本').split('\n').map(l => l.trim()).filter(Boolean)) {
        const parts = line.split('|').map(p => p.trim());
        const head = parts[0];
        if (head === '旁白') stage.push({ kind: 'narration', text: stripLeakedAttrs(parts.slice(1).join('|')) });
        else if (head === '上场') stage.push({ kind: 'enter', actorName: parts[1], text: parts[1] || '' });
        else if (head === '下场') stage.push({ kind: 'exit', actorName: parts[1], text: parts[1] || '' });
        else if (head === '台词') stage.push({ kind: 'line', actorName: parts[1], text: stripLeakedAttrs(parts.slice(2).join('|')) });
    }
    const reviews = pick('观众').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [critic, ...rest] = l.split(/[|｜:：]/);
        return { critic: (critic || '观众').replace(/^[-·•\s]+/, '').trim(), text: rest.join('：').trim() };
    }).filter(r => r.text);
    const rating = stripLeakedAttrs(pick('评级')) || 'B';
    return { stage, reviews, rating };
}
