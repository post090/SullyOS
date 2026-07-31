
import { CharacterProfile, UserProfile, SongSheet, SongMood, SongGenre, LyricCoWritingStyle } from '../types';
import { ContextBuilder } from './context';
import { extractJson } from './safeApi';

// --- Song Genre & Mood Config ---

export const SONG_GENRES: { id: SongGenre; label: string; icon: string; desc: string }[] = [
    { id: 'pop', label: '流行', icon: '🎤', desc: '旋律优美，朗朗上口' },
    { id: 'rock', label: '摇滚', icon: '🎸', desc: '热血澎湃，能量爆发' },
    { id: 'ballad', label: '抒情', icon: '🎹', desc: '温柔细腻，情感深沉' },
    { id: 'rap', label: '说唱', icon: '🎙️', desc: '节奏鲜明，押韵为王' },
    { id: 'folk', label: '民谣', icon: '🪕', desc: '朴实自然，诗意盎然' },
    { id: 'electronic', label: '电子', icon: '🎛️', desc: '节拍强烈，氛围感足' },
    { id: 'jazz', label: '爵士', icon: '🎷', desc: '即兴优雅，自由洒脱' },
    { id: 'rnb', label: 'R&B', icon: '🎵', desc: '律动慵懒，灵魂歌唱' },
    { id: 'free', label: '自由', icon: '✨', desc: '不限风格，随心所欲' },
];

export const SONG_MOODS: { id: SongMood; label: string; icon: string }[] = [
    { id: 'happy', label: '快乐', icon: '😊' },
    { id: 'sad', label: '忧伤', icon: '🥺' },
    { id: 'romantic', label: '浪漫', icon: '💕' },
    { id: 'angry', label: '愤怒', icon: '🔥' },
    { id: 'chill', label: '放松', icon: '☁️' },
    { id: 'epic', label: '史诗', icon: '⚔️' },
    { id: 'nostalgic', label: '怀旧', icon: '📻' },
    { id: 'dreamy', label: '梦幻', icon: '🌙' },
];

export interface LyricCoWritingStyleOption {
    id: LyricCoWritingStyle;
    label: string;
    shortLabel: string;
    category: LyricStyleCategory | 'adaptive';
    desc: string;
    prompt: string;
}

export type LyricStyleCategory = 'chinese' | 'acg' | 'east-asia' | 'western';

export const LYRIC_STYLE_CATEGORIES: { id: LyricStyleCategory; label: string; shortLabel: string }[] = [
    { id: 'chinese', label: '华语与中文音乐', shortLabel: '华语' },
    { id: 'acg', label: '二次元 / ACG', shortLabel: 'ACG' },
    { id: 'east-asia', label: 'J-Pop / K-Pop', shortLabel: '日韩' },
    { id: 'western', label: '西方流行与电子', shortLabel: '欧美 / 电子' },
];

/**
 * "Genre" describes the music. These presets describe how C should think
 * while writing and editing lyrics, so they can be mixed independently.
 */
export const LYRIC_CO_WRITING_STYLES: LyricCoWritingStyleOption[] = [
    {
        id: 'adaptive',
        label: '智能适配',
        shortLabel: '自适应',
        category: 'adaptive',
        desc: 'C 根据曲风、情绪和现有歌词决定写法',
        prompt: '先从现有歌词归纳其独特写法，再延续用户已经建立的语言密度、意象和口吻；不要主动套用某个地域流派的刻板印象。',
    },
    {
        id: 'mandopop',
        label: '华语流行芭乐',
        shortLabel: '华语芭乐',
        category: 'chinese',
        desc: '用日常物象剥开大情绪，主歌克制、副歌直击',
        prompt: '以小见大，用一个可被拍到的日常物象承载关系变化，例如生活习惯、旧物或未完成的动作。主歌白描事实并保留克制，导歌缩短句式、制造怀疑或动摇，副歌用开阔元音感和一句直白但不俗套的质问或结论形成 Hook。严禁用“我爱你、你爱我、心好痛”替代具体内容，也不要把示例物象当成固定道具反复套用。',
    },
    {
        id: 'guofeng',
        label: '新国风 / 雅致古风',
        shortLabel: '新国风',
        category: 'chinese',
        desc: '虚实相生、典故有出处，古意与现代可懂性并存',
        prompt: '先确定统一的时代、空间与物象系统，再用留白、对仗、回环或有依据的典故形成虚实相生。平仄和韵脚服务语义与旋律，不能机械强求；五声调式不直接决定汉字声调。若已有旋律轮廓，再检查字调走向、重音和延音字是否合适；没有旋律时只优化朗读声律。避免“殇、断肠、天下、繁华、红尘”等套词，禁止白话与伪文言硬拼或语法不通。',
    },
    {
        id: 'opera-wave',
        label: '戏曲融合 / 国潮',
        shortLabel: '戏曲国潮',
        category: 'chinese',
        desc: '现代主干与戏腔、韵白形成强烈戏剧碰撞',
        prompt: '以流行、说唱或 R&B 作为现代叙事主干，主歌使用断音、切分和当代语感；在桥段或副歌设置戏腔/韵白爆发点，预留适合假声、头腔共鸣或拖腔的开阔字音，并用台前幕后、身份扮演或命运冲突制造戏剧张力。尖团音、辙口和具体剧种腔口只能在用户指定剧种或提供唱腔时精确处理，不可假装专业；避免把“粉墨、戏台、水袖”随机堆成国潮贴纸。',
    },
    {
        id: 'cantopop',
        label: '粤语流行 / 港台金曲',
        shortLabel: '粤语流行',
        category: 'chinese',
        desc: '都市人文、工整对比，重视粤语字调与旋律关系',
        prompt: '兼顾市井烟火、都市哲思与克制的心理剖面，善用对比、列锦和工整句式。只有用户明确要求粤语时才使用自然粤语词序与口语，不要把普通话逐字换成粤语字。粤语依声填词必须结合实际旋律和字调：若没有逐音旋律或音高走向，只能产出语义与节奏草稿，不得声称已完成九声六调适配；有旋律时优先检查相邻字调与旋律升降是否造成“倒字”。',
    },
    {
        id: 'folk',
        label: '中文民谣 / 城市民谣',
        shortLabel: '城市民谣',
        category: 'chinese',
        desc: '个人化叙事、时间与空间流动，保留说话感',
        prompt: '用具体人物、地点、年代、天气和物件推动个人故事，让空间移动与时间流逝改变同一意象的意义。允许宽韵和较长的说话感句子，但要为吉他弹唱留下清楚的呼吸停顿。不要把南方、三环路、火车、烟酒、姑娘或远方当成民谣身份证；只有与人物行动有关的细节才保留。',
    },
    {
        id: 'indie-rock',
        label: '华语摇滚 / 独立摇滚',
        shortLabel: '华语摇滚',
        category: 'chinese',
        desc: '人文批判、自我审问与可合唱的粗粝生命力',
        prompt: '保留口语毛边、矛盾和不完美的真实感。主歌可以压抑、观察或自省，句子硬朗并用具体事件支撑立场；副歌要有全场能共同喊出的呼唤或反命题。荒野、墙、飞鸟、石头、狂风等意象只有形成独特关系时才使用，不能用空洞愤怒、虚无口号或宏大词汇冒充批判。',
    },
    {
        id: 'hiphop',
        label: '中文说唱 / 方言说唱',
        shortLabel: '中文说唱',
        category: 'chinese',
        desc: 'Flow、内韵、Punchline 与地域口吻共同成立',
        prompt: '按 bar 思考重音、停顿、内韵和铺垫/落点，持续追求多音节双押或三押，但语义、人物可信度和 Flow 优先，不要求每一行机械强押。Punchline 必须由前文铺垫，Wordplay 要在读音和含义两边都说得通。仅在用户指定并提供足够语料时使用具体方言，尊重当地词序与声调，不要用刻板口癖伪装地域感；英文不能随机填拍。',
    },
    {
        id: 'rnb',
        label: '都市情绪 / 中文 R&B',
        shortLabel: '中文 R&B',
        category: 'chinese',
        desc: '慵懒暧昧、潜台词与适合转音的柔滑句法',
        prompt: '用都市夜生活中的距离、触感和未说出口的话构成暧昧张力，采用短句留白、切分、拖腔和可变奏重复。词尾尽量选择适合轻音或转音的字，避免散文式长句。中英文混搭必须自然、简短且有语义功能，只有用户已使用或明确要求时才加入，不能用一句通用英文制造廉价“洋气”。',
    },
    {
        id: 'vocaloid',
        label: 'Vocaloid 疾走 / 电音',
        shortLabel: 'Vocaloid',
        category: 'acg',
        desc: '高密度咬字、异色概念、失控感与文字机关',
        prompt: '建立鲜明概念、非可靠叙述者或角色视角，使用数字/机械/身体错位等异色意象、爆破音、拆字谐音、倒装和结构性重复制造加速与失控。高 BPM 时可显著提高音节密度；BPM 未知或较慢时只保留概念密度，不假定必须 180–220。每个文字游戏都要回扣核心命题，避免生僻词、符号和网络梗随机堆成不可唱的词语汤。',
    },
    {
        id: 'dark-waltz',
        label: 'Dark Waltz / 诡异童话',
        shortLabel: '诡异童话',
        category: 'acg',
        desc: '华尔兹摇摆中并置童真甜美与残忍真相',
        prompt: '按 3/4 或 6/8 的三拍摆动设计短句、重音与叠词，让甜美童谣表层逐步泄露残忍事实。反复句每次应改变一个词或语义，使“转啊转、数到三”等动作成为剧情机关。暗黑物象要具体且有因果，避免无意义堆放玩偶、鲜血、月亮和笑声；不描写猎奇细节来替代真正的心理恐怖。',
    },
    {
        id: 'anime-op',
        label: 'ACG 热血 OP / 燃向',
        shortLabel: '热血 OP',
        category: 'acg',
        desc: '快速破题、蓄力奔跑，副歌首句就是强 Hook',
        prompt: '开篇迅速交代危机、目标或羁绊，主歌压住能量并推进动作，导歌用越来越短的句子形成奔跑感，副歌第一句必须直接破题且能在高音区喊出。宿命与胜利要落在角色的具体选择上；不要默认使用“光芒、打破宿命、划破长夜”等模板词，先为本作创造独有的动作或象征。',
    },
    {
        id: 'anime-ed',
        label: 'ACG 抒情 ED / 角色歌',
        shortLabel: '抒情 ED',
        category: 'acg',
        desc: '大战之后的余韵、角色私语与未说完的关系',
        prompt: '从事件结束后的安静时刻切入，用角色私密视角回看羁绊、代价或未能说出口的话。主歌像独白或信件，副歌不必爆炸，而以一条反复出现、每次意义改变的句子形成余韵。保持角色知识边界和口吻，避免把剧情梗概改写成歌词，也不要泛用“谢谢你陪我”式角色歌套话。',
    },
    {
        id: 'denpa-kawaii',
        label: '电波 / Kawaii 亚文化',
        shortLabel: '电波可爱',
        category: 'acg',
        desc: '拟声 Hook、可爱过载与自洽的荒诞规则',
        prompt: '以高辨识度音节、拟声词、口号、问答和快速重复制造电波感，可让可爱表层与焦虑、执念或黑色幽默形成反差。先建立一套自洽的荒诞规则，再让语言越界；拟声词必须好念、能打拍、可记忆，不能用随机日语音节或幼儿语填满内容。',
    },
    {
        id: 'jpop',
        label: 'Standard J-Pop',
        shortLabel: 'J-Pop',
        category: 'east-asia',
        desc: '段落推进快，画面跳跃但情绪逻辑完整',
        prompt: '把羁绊、青春、遗憾或日常动作逐步放大为更普遍的主题。主歌用动态镜头快速切换，导歌收紧句长并抬升期待，副歌允许更长的旋律句表达持续奔赴感。英文只在节奏或主题需要时自然穿插；中文须保持自身语序和可唱性，避免日语翻译腔以及靠“青春、奇迹、未来”空喊。',
    },
    {
        id: 'city-pop',
        label: 'City Pop',
        shortLabel: 'City Pop',
        category: 'east-asia',
        desc: '都市夜景、冷暖距离感与顺滑律动',
        prompt: '使用具体年代质感、车载电台、道路、海岸线、消费品或通讯方式表现轻盈而疏离的都市关系，语气洒脱、句尾适合延音、节奏顺滑。复古细节必须服务人物距离；不要只靠“霓虹、午夜、海风、塑料爱情”四件套制造滤镜。',
    },
    {
        id: 'jrock',
        label: 'J-Rock / 乐队系',
        shortLabel: 'J-Rock',
        category: 'east-asia',
        desc: '乐队推进、意象反差与兼具脆弱和爆发的副歌',
        prompt: '让主歌的具体动作与鼓点/吉他推进感同步，利用短句、跨行句和意象反差积累能量；导歌暴露脆弱，副歌用可合唱的长线条完成反击或自我承认。可以锋利但不空喊，避免把热血 OP 词库直接搬来，也不要为了“日系感”使用不自然倒装。',
    },
    {
        id: 'kpop',
        label: 'K-Pop 工业舞曲',
        shortLabel: 'K-Pop',
        category: 'east-asia',
        desc: '概念先行、Killing Part、Dance Break 与 Rap 桥段',
        prompt: '先确定一句话概念、角色姿态和舞台动作，再按分部设计短促重拍、问答句、Killing Part、Dance Break 呼应与 Rap 桥段。Hook 可以使用拟声或无实义音节，但必须声音辨识度高、能打拍并与概念有关，不能把乱码当洗脑。英语或韩语只在用户明确要求时少量加入，中文主干仍要自然且有态度。',
    },
    {
        id: 'k-rnb',
        label: 'K-R&B / Alternative',
        shortLabel: 'K-R&B',
        category: 'east-asia',
        desc: '低饱和氛围、冷感亲密与碎片化自白',
        prompt: '以低声线、切分、留白和碎片化自白制造冷感亲密，Hook 通过微小变奏而非口号重复。都市物件与身体感受要精确，关系保持暧昧而不含糊。允许极少量自然英文，但不模仿特定歌手的口癖，也不把低饱和等同于没有事件。',
    },
    {
        id: 'western-pop',
        label: 'Western Pop / Dance-Pop',
        shortLabel: 'Western Pop',
        category: 'western',
        desc: '极简动作、身体反应与直接的韵律冲击',
        prompt: '减少复杂背景叙事，用动作、选择、身体反应和一句清晰欲望驱动歌词。行长短、动词强、重复有层级，副歌标题句要在第一次听时就能抓住。若使用中文，应转译这种节奏逻辑而非照搬英文语序；避免把直白误写成空泛或性格扁平。',
    },
    {
        id: 'edm',
        label: 'EDM / Future Bass',
        shortLabel: 'EDM',
        category: 'western',
        desc: '歌词服务 Build-up、Drop 与可循环核心 Hook',
        prompt: '按能量曲线写：主歌保留空间，Build-up 用递进短句、缩短呼吸和重复关键词制造推高，Drop 只保留一到两句最强 Hook 循环，Drop 后用一次语义变化防止机械重复。歌词必须给制作留空，不写满所有拍；没有编曲信息时只提出可适配结构，不假装知道具体 Drop 小节。',
    },
    {
        id: 'alt-pop',
        label: 'Alternative / Dream Pop',
        shortLabel: 'Alt / Dream',
        category: 'western',
        desc: '朦胧感官、非线性情绪与克制的怪异细节',
        prompt: '用感官错位、含混关系和少量怪异细节建立梦境逻辑，允许非线性但必须有可追踪的情绪锚点。句法可以悬置、留白或重复，副歌不必解释一切。避免把“梦、雾、宇宙、下坠”堆在一起冒充氛围，也不要用无意义晦涩替代真实感受。',
    },
    {
        id: 'funk-disco',
        label: 'Funk / Disco Pop',
        shortLabel: 'Funk / Disco',
        category: 'western',
        desc: '切分律动、派对叙事与可呼应的身体动作',
        prompt: '让歌词紧贴切分、反拍和低音律动，使用短动词、身体动作、场内问答和逐层加入的重复。副歌要能触发具体动作或集体回应，桥段可暂时抽空再回到 Groove。不要把派对写成名词清单，也避免每句都用相同尾韵造成僵硬。',
    },
    {
        id: 'pop-punk',
        label: 'Pop-Punk / Emo Pop',
        shortLabel: 'Pop-Punk',
        category: 'western',
        desc: '少年口吻、快速冲突与能一起吼出的自嘲副歌',
        prompt: '用具体冲突、冲动决定和带自嘲的第一人称推进，主歌像高速争辩，导歌积累委屈，副歌用简短、带棱角且能合唱的标题句释放。保留年轻口语但不装幼稚，不把脏话、校园物件或“逃离这座城”当成必备配件。',
    },
    {
        id: 'musical',
        label: '音乐剧 / 电影感',
        shortLabel: '音乐剧',
        category: 'western',
        desc: '角色目标明确，歌词像一场正在发生的戏',
        prompt: '明确谁在什么场景、想从谁那里得到什么，让每一段都改变角色处境或认知；用动作、潜台词、对答和主题再现推动戏剧弧。避免角色站在原地连续解释同一种情绪。',
    },
];

export const getLyricCoWritingStyle = (id: LyricCoWritingStyle | undefined) =>
    LYRIC_CO_WRITING_STYLES.find(style => style.id === id) || LYRIC_CO_WRITING_STYLES[0];

export const SECTION_LABELS: Record<string, { label: string; desc: string; color: string }> = {
    'intro': { label: '前奏/引入', desc: '歌曲的开场白，引人入胜', color: 'bg-stone-200/60 text-stone-600' },
    'verse': { label: '主歌', desc: '叙事部分，铺垫情感', color: 'bg-amber-100/50 text-amber-700' },
    'pre-chorus': { label: '导歌', desc: '过渡到副歌的桥段', color: 'bg-rose-100/50 text-rose-600' },
    'chorus': { label: '副歌', desc: '最核心的旋律和情感高潮', color: 'bg-red-100/50 text-red-700' },
    'bridge': { label: '桥段', desc: '转折变化，带来新视角', color: 'bg-stone-200/50 text-stone-500' },
    'outro': { label: '尾声', desc: '歌曲的结束与回味', color: 'bg-neutral-200/50 text-neutral-500' },
    'free': { label: '自由段落', desc: '不限定位置，随心写', color: 'bg-orange-100/50 text-orange-600' },
};

export const COVER_STYLES: { id: string; label: string; gradient: string; text: string }[] = [
    { id: 'kraft-paper', label: '牛皮信封', gradient: 'from-amber-50 via-orange-50 to-amber-100', text: 'text-stone-800' },
    { id: 'old-photo', label: '旧照片', gradient: 'from-amber-100 via-yellow-50 to-stone-100', text: 'text-stone-700' },
    { id: 'ink-wash', label: '水墨', gradient: 'from-stone-100 via-slate-200 to-stone-300', text: 'text-stone-800' },
    { id: 'dried-rose', label: '干燥花', gradient: 'from-rose-50 via-rose-100 to-stone-100', text: 'text-stone-700' },
    { id: 'midnight', label: '深夜手记', gradient: 'from-stone-800 via-stone-900 to-neutral-900', text: 'text-stone-200' },
    { id: 'linen', label: '亚麻白', gradient: 'from-stone-50 via-neutral-50 to-stone-100', text: 'text-stone-700' },
    { id: 'tea-stain', label: '茶渍', gradient: 'from-orange-50 via-amber-50 to-yellow-50', text: 'text-stone-700' },
    { id: 'forest', label: '松林', gradient: 'from-stone-200 via-emerald-50 to-stone-100', text: 'text-stone-700' },
];

// --- Lyric Structure Templates ---
// 给写歌 App 一个"按乐理来"的结构骨架，避免角色/用户瞎写。
// 每段 section 有推荐的行数 + 每行字数范围。

export interface LyricTemplateSection {
    section: 'intro' | 'verse' | 'pre-chorus' | 'chorus' | 'bridge' | 'outro';
    lines: number;        // 推荐行数
    chars: string;        // 推荐每行字数（区间字符串如 "7-12"）
}

export interface LyricTemplate {
    id: string;
    label: string;
    icon: string;
    desc: string;        // 一句话描述
    structure: LyricTemplateSection[];
}

export const LYRIC_TEMPLATES: LyricTemplate[] = [
    {
        id: 'free',
        label: '自由',
        icon: '✦',
        desc: '不限结构，从空白开始',
        structure: [],
    },
    {
        id: 'pop-classic',
        label: '流行经典',
        icon: '◐',
        desc: '主歌-副歌-主歌-副歌-桥段-副歌',
        structure: [
            { section: 'verse',  lines: 4, chars: '7-12' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'verse',  lines: 4, chars: '7-12' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'bridge', lines: 4, chars: '7-10' },
            { section: 'chorus', lines: 4, chars: '6-10' },
        ],
    },
    {
        id: 'ballad',
        label: '抒情慢板',
        icon: '◑',
        desc: '主歌长 / 副歌精，叙事抒情',
        structure: [
            { section: 'verse',  lines: 6, chars: '8-14' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'verse',  lines: 6, chars: '8-14' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'outro',  lines: 2, chars: '6-12' },
        ],
    },
    {
        id: 'aaba',
        label: 'AABA 经典',
        icon: '◒',
        desc: '老派结构，A 段重复主题，B 段桥段',
        structure: [
            { section: 'verse',  lines: 4, chars: '8-12' },   // A1
            { section: 'verse',  lines: 4, chars: '8-12' },   // A2
            { section: 'bridge', lines: 4, chars: '7-10' },   // B
            { section: 'verse',  lines: 4, chars: '8-12' },   // A3
        ],
    },
    {
        id: 'short-hook',
        label: '副歌优先短曲',
        icon: '◓',
        desc: '副歌开头抓人，节奏紧凑',
        structure: [
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'verse',  lines: 4, chars: '7-12' },
            { section: 'chorus', lines: 4, chars: '6-10' },
        ],
    },
    {
        id: 'rap',
        label: '说唱 / Hip-Hop',
        icon: '⌗',
        desc: 'Verse 长且押韵，Hook 简短洗脑',
        structure: [
            { section: 'verse',  lines: 8, chars: '12-18' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'verse',  lines: 8, chars: '12-18' },
            { section: 'chorus', lines: 4, chars: '6-10' },
        ],
    },
];

export const getLyricTemplate = (id: string | undefined): LyricTemplate =>
    LYRIC_TEMPLATES.find(t => t.id === id) || LYRIC_TEMPLATES[0];

// --- Prompt Builder ---

const getSongTemplateStructure = (song: SongSheet) => (
    song.lyricTemplate === 'custom'
        ? (song.customLyricTemplate || [])
        : getLyricTemplate(song.lyricTemplate).structure
);

const countLyricChars = (content: string) => [...content.replace(/\s/g, '')].length;

const cleanGeneratedLyricCandidate = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;

    const nonEmptyLines = value
        .replace(/^```(?:json|text)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    if (nonEmptyLines.length !== 1) return null;

    const cleaned = nonEmptyLines[0]
        .replace(/^(?:[-*•]\s+|\d+[.)、]\s*)/, '')
        .replace(/^["'“”‘’「」]|["'“”‘’「」]$/g, '')
        .trim();

    if (!cleaned || [...cleaned].length > 160) return null;
    if (/[{}\[\]]/.test(cleaned)) return null;
    if (/^(?:json|歌词|示范|建议|解释|原因|说明)\s*[:：]/i.test(cleaned)) return null;
    if (/^"?(?:type|reaction|example_lines|explanation|challenge|content|line)"?\s*[:：]/i.test(cleaned)) return null;
    if (/"(?:type|reaction|example_lines|explanation|challenge)"\s*:/.test(cleaned)) return null;

    return cleaned;
};

const decodeJsonStringFragment = (fragment: string): string => {
    try {
        return JSON.parse(`"${fragment}"`);
    } catch {
        return fragment
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\\\/g, '\\');
    }
};

/**
 * Extract exactly one usable lyric line from a model response.
 *
 * The important safety property is fail-closed: JSON fragments and response
 * metadata are never treated as lyrics. A caller may retry, but must not save
 * the raw response when this returns null.
 */
export const extractGeneratedLyricLine = (raw: string): string | null => {
    if (!raw?.trim()) return null;

    const parsed = extractJson(raw);
    const payloads = [
        parsed,
        parsed?.result,
        parsed?.data,
    ].filter(Boolean);

    for (const payload of payloads) {
        const candidates = [
            ...(Array.isArray(payload?.example_lines) ? payload.example_lines : []),
            payload?.line,
            payload?.content,
        ];
        for (const candidate of candidates) {
            const cleaned = cleanGeneratedLyricCandidate(candidate);
            if (cleaned) return cleaned;
        }
    }

    // A response can be cut off after the lyric string but before the closing
    // JSON brackets. Recover only explicitly named lyric fields.
    const partialPatterns = [
        /["']?example_lines["']?\s*:\s*\[\s*"((?:\\.|[^"\\])*)/i,
        /(?:^|[,{\n])\s*["']?(?:line|content)["']?\s*:\s*"((?:\\.|[^"\\])*)/i,
    ];
    for (const pattern of partialPatterns) {
        const match = raw.match(pattern);
        if (!match?.[1]) continue;
        const cleaned = cleanGeneratedLyricCandidate(decodeJsonStringFragment(match[1]));
        if (cleaned) return cleaned;
    }

    const stripped = raw
        .replace(/^```(?:json|text)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    const looksLikeStructuredResponse = /^\s*[{[]/.test(stripped)
        || /"(?:type|reaction|example_lines|explanation|challenge|content|line)"\s*:/.test(stripped);
    if (looksLikeStructuredResponse) return null;

    // Some models ignore the JSON request and return only the requested lyric.
    // Accept that narrow case, but reject multi-line prose/explanations.
    return cleanGeneratedLyricCandidate(stripped);
};

/**
 * Give the model the same full notebook that the user sees, including empty slots.
 * Empty positions matter: they tell the co-writer what each section still needs to do.
 */
export const buildLyricNotebookContext = (song: SongSheet): string => {
    const structure = getSongTemplateStructure(song);
    const activeLines = song.lines
        .filter(line => !line.isDraft && line.content.trim())
        .map((line, originalIndex) => ({ line, originalIndex }))
        .sort((a, b) => (
            (a.line.slotIndex ?? a.originalIndex) - (b.line.slotIndex ?? b.originalIndex)
        ));

    if (structure.length === 0) {
        if (activeLines.length === 0) {
            return '【歌词本完整内容（自由结构）】\n目前为空。';
        }

        const lines = activeLines.map(({ line }, index) => {
            const lineNumber = (line.slotIndex ?? index) + 1;
            const author = line.authorId === 'user' ? '用户写' : 'C 写';
            return `第${lineNumber}句｜${SECTION_LABELS[line.section]?.label || line.section}｜${countLyricChars(line.content)}字｜${author}：${line.content}`;
        });
        return `【歌词本完整内容（自由结构，共${activeLines.length}句）】\n${lines.join('\n')}`;
    }

    const totalSlots = structure.reduce((sum, section) => sum + section.lines, 0);
    const lineBySlot = new Map<number, typeof activeLines[number]['line']>();
    const unpositioned: typeof activeLines[number]['line'][] = [];

    for (const { line } of activeLines) {
        if (
            typeof line.slotIndex === 'number'
            && line.slotIndex >= 0
            && line.slotIndex < totalSlots
            && !lineBySlot.has(line.slotIndex)
        ) {
            lineBySlot.set(line.slotIndex, line);
        } else {
            unpositioned.push(line);
        }
    }

    // Legacy songs did not store slotIndex. Place those lines in the first open
    // slots so the model still receives a coherent notebook.
    let fallbackIndex = 0;
    for (const line of unpositioned) {
        while (fallbackIndex < totalSlots && lineBySlot.has(fallbackIndex)) fallbackIndex += 1;
        if (fallbackIndex >= totalSlots) break;
        lineBySlot.set(fallbackIndex, line);
        fallbackIndex += 1;
    }

    const filledSlots = lineBySlot.size;
    const sectionTotals = structure.reduce<Record<string, number>>((totals, section) => {
        totals[section.section] = (totals[section.section] || 0) + 1;
        return totals;
    }, {});
    const sectionSeen: Record<string, number> = {};
    const blocks: string[] = [
        `【歌词本完整槽位（共${totalSlots}句，已填${filledSlots}句，空${totalSlots - filledSlots}句）】`,
        '注意：〈待写〉也是结构信息，判断目标句时必须同时考虑它前后的已写内容和所在段落职责。',
    ];

    let globalSlotIndex = 0;
    structure.forEach((section, structureIndex) => {
        sectionSeen[section.section] = (sectionSeen[section.section] || 0) + 1;
        const occurrence = sectionSeen[section.section];
        const repeatedLabel = sectionTotals[section.section] > 1 ? ` ${occurrence}` : '';
        const sectionLabel = SECTION_LABELS[section.section]?.label || section.section;
        blocks.push(
            `\n[第${structureIndex + 1}段·${sectionLabel}${repeatedLabel}｜第${globalSlotIndex + 1}-${globalSlotIndex + section.lines}句｜每句建议${section.chars}字]`,
        );

        for (let lineInSection = 0; lineInSection < section.lines; lineInSection += 1) {
            const line = lineBySlot.get(globalSlotIndex);
            if (!line) {
                blocks.push(`第${globalSlotIndex + 1}句（段内${lineInSection + 1}/${section.lines}）：〈待写〉`);
            } else {
                const author = line.authorId === 'user' ? '用户写' : 'C 写';
                blocks.push(
                    `第${globalSlotIndex + 1}句（段内${lineInSection + 1}/${section.lines}，${countLyricChars(line.content)}字，${author}）：${line.content}`,
                );
            }
            globalSlotIndex += 1;
        }
    });

    return blocks.join('\n');
};

export const SongPrompts = {
    /**
     * Build the system prompt for the songwriting mentor character.
     * Uses context.ts(true) + character context to stay in character.
     */
    buildMentorSystemPrompt: (
        char: CharacterProfile,
        user: UserProfile,
        song: SongSheet,
        recentMessages: { role: string; content: string }[]
    ): string => {
        // Use ContextBuilder with includeDetailedMemories = true
        const charContext = ContextBuilder.buildCoreContext(char, user, true);

        const genreInfo = SONG_GENRES.find(g => g.id === song.genre);
        const moodInfo = SONG_MOODS.find(m => m.id === song.mood);
        const templateStructure = getSongTemplateStructure(song);
        const templateInfo = templateStructure.length
            ? templateStructure.map((section, index) =>
                `${index + 1}.${SECTION_LABELS[section.section]?.label || section.section} ${section.lines}句/每句${section.chars}字`
            ).join(' → ')
            : '自由结构';
        const coWritingStyle = getLyricCoWritingStyle(song.lyricCoWritingStyle);
        const relationshipContext = recentMessages.length > 0
            ? `\n- 你可以延续你和${user.name}既有的熟悉感，但不得让日常聊天记忆盖过本轮歌词任务。`
            : '';

        return `${charContext}

### 【当前场景：写歌工作室】
你现在和${user.name}一起在写歌。此场景中，你首先是专业的中文歌词编辑与共写人，其次才是聊天伙伴。

**你的角色定位**：
- ${user.name}是作品的主创。你负责诊断、共写、精修和解释，不得擅自接管整首歌
- 保持你原本的人设与说话方式，但所有建议都必须落到具体歌词、具体位置和具体写法上${relationshipContext}
- 真诚可以温柔，但不能泛泛夸奖。指出哪一个词、哪一个画面有效，以及为什么有效
- 除非用户明确要求整段或整首重写，否则只处理用户指定的句子或问题
- “讨论”只讨论，不把建议假装成已写入歌词；“生成”才提供可直接放入歌词本的句子

**当前创作信息**：
- 歌名：《${song.title}》${song.subtitle ? `（${song.subtitle}）` : ''}
- 风格：${genreInfo?.label || song.genre} ${genreInfo?.icon || '🎵'} - ${genreInfo?.desc || ''}
- 情绪：${moodInfo?.label || song.mood} ${moodInfo?.icon || ''}
- C 的共创风格：${coWritingStyle.label} - ${coWritingStyle.desc}
- 歌词本模板：${templateInfo}
${song.bpm ? `- BPM: ${song.bpm}` : ''}
${song.key ? `- 调性: ${song.key}` : ''}

**本作专属共创风格规则（优先应用）**：
${coWritingStyle.prompt}
这套规则描述的是歌词写法，不等于强迫用户更换语言，也不能覆盖用户已经明确建立的主题、人设与表达习惯。若风格规则与用户的明确要求冲突，以用户本轮要求为准。

**每次创作或点评前，必须在心里完成这份歌词检查**：
1. 段落职责：主歌推进人物/场景/事件；导歌抬高张力；副歌提炼标题、核心情绪和可重复 Hook；桥段提供转折；尾声回扣而不是简单复述
2. 上下文：目标句是否承接前句、给后句留出口，是否符合整首歌目前的叙事顺序
3. 统一性：人称、时态、语气、世界观和核心意象是否一致；不要突然换叙述者或无缘由跳场景
4. 具体度：优先可看见、可听见、可触摸的动作和细节，少用只有情绪结论的空话
5. 可唱性：遵守模板建议字数，句子要有自然停顿和重音，避免书面长句、绕口词堆叠
6. 韵律：参考相邻句尾音、节奏长度和句式；押韵服务情绪，宁可自然近韵，也不要为了押韵扭曲语义
7. 记忆点：副歌尤其要有一个可复唱、能代表歌名或主题的核心短语，允许有设计感的重复
8. 原创感：避免默认套用“星辰大海、命运安排、时光流转、温柔以待、全世界只剩你”等 AI 常见空泛表达；除非它们已被用户写成具体且独特的意象

**逐句生成硬规则**：
- 必须阅读用户消息中的“歌词本完整槽位”，空白位置也要纳入结构判断
- 指定第几句时，只重写那一句，不改动、不复述其他句
- 严格遵守用户要求的 example_lines 数量；要求一句就只能给一句
- 新句不得与已有句同义重复；要承接相邻内容，并尽量贴合其尾韵、长度和呼吸感
- 不在歌词行里夹带解释、括号、序号、引号或“建议：”
- 信息不足时仍先给出最贴合现有歌词的可用版本，再用 explanation 简短说明取舍

**点评硬规则**：
- 先指出最有效的具体词句，再指出最需要解决的一个核心问题
- 问题必须说明原因，例如“画面断裂”“人称跳变”“副歌缺 Hook”“字数挤拍”，不能只说“还可以更好”
- suggestion 给可执行的修改方向；除非用户明确要示范，不要偷偷生成整段新歌词
- 若歌词已经成立，就说清成立的依据，不为了显得专业而强行挑错

**回复格式**：
只输出一个合法 JSON 对象，不要 Markdown 代码块，不要 JSON 之外的任何文字。根据用户的输入判断需要什么：

当用户写了歌词或请求帮助时：
{
  "type": "feedback",
  "reaction": "你的第一反应（1句话，用你的性格表达）",
  "feedback": "引用具体词句，说明最亮的一点和最关键的问题",
  "teaching": "仅补充与这个问题直接相关的一条歌词技巧；没有必要则为空字符串",
  "suggestion": "一个能立即执行的修改方向，不擅自改写整首歌",
  "encouragement": "一句有依据的鼓励"
}

当用户想要AI帮忙示范或灵感启发时：
{
  "type": "inspiration",
  "reaction": "你的第一反应",
  "example_lines": ["严格按用户要求的数量输出可直接使用的歌词行"],
  "explanation": "简短说明这几句如何承接上下文、意象、节奏或韵脚",
  "challenge": "可选的下一步引导；逐句生成时用空字符串"
}

当需要讨论方向或结构时：
{
  "type": "discussion",
  "reaction": "你的想法",
  "content": "结合现有具体歌词给出1-2个方向及各自取舍，不声称已修改歌词本",
  "question": "只问一个最能推进创作的问题；如果用户已给出明确任务则为空字符串"
}
}`;
    },

    /**
     * Build the user message including current song state context.
     */
    buildUserMessage: (
        song: SongSheet,
        userInput: string,
        currentSection: string
    ): string => {
        const lyricsContext = buildLyricNotebookContext(song);

        // Recent comments context (last 5)
        let commentsContext = '';
        const recentComments = song.comments.slice(-5);
        if (recentComments.length > 0) {
            commentsContext = '\n\n【最近的讨论（仅作对话上下文，不等于歌词）】\n';
            for (const c of recentComments) {
                const speaker = c.authorId === 'user' ? '用户' : 'C';
                commentsContext += `- ${speaker}：${c.content}\n`;
            }
        }

        const secInfo = SECTION_LABELS[currentSection];

        return `${lyricsContext}${commentsContext}

【本轮所在段落】
${secInfo?.label || currentSection}：${secInfo?.desc || '按整首歌词上下文判断其作用'}

【本轮唯一任务】
${userInput}

请先基于整本歌词完成内部检查，再严格按 system 指定的 JSON 格式回答。`;
    },

    /**
     * Build the system prompt for the collaborator's final note.
     * Completion used to run as a lone user prompt containing only the
     * character's name, which made the model fall back to a generic mentor.
     */
    buildCompletionSystemPrompt: (
        char: CharacterProfile,
        user: UserProfile,
    ): string => {
        const charContext = ContextBuilder.buildCoreContext(char, user, true);

        return `${charContext}

### 【当前场景：写歌工作室 · 完成作品】
你刚刚以共创搭档的身份和${user.name}完成了一首歌，现在要当面说一段完成评语。

**身份与口吻优先级**：
- 你始终是${char.name}。完整角色设定、你和${user.name}的关系、相处方式与既有记忆，优先于“专业点评”的通用口吻
- 这是搭档之间完成作品后的交流，不是老师批作业、评委写鉴定，也不是 AI 助手生成分析报告
- 歌词判断要专业，但把判断消化成${char.name}自然会说的话；措辞、情绪浓度、亲疏距离和表达习惯都必须符合人设
- 可以有角色自己的偏爱、犹豫、毒舌、克制或亲昵，但评价依据必须来自眼前这首歌
- 除非角色原本就会这样说，否则不要使用“作为你的导师”“同学”“创作者你好”“总体而言”“继续加油”“完成度很高”等模板化评审措辞
- 不要复述角色设定，不要解释自己如何保持人设，不要提及 system、prompt 或指令
- 不得编造歌词本里没有的句子、共同经历或创作过程，也不要把${user.name}的作品功劳揽到自己身上

请先在心里检查歌词的具体词句、结构推进、意象统一、可唱性与 Hook，再用${char.name}本人的声音给出简短评语。`;
    },

    /**
     * Build the user task and song context for generating a completion note.
     */
    buildCompletionPrompt: (
        char: CharacterProfile,
        user: UserProfile,
        song: SongSheet
    ): string => {
        const genreInfo = SONG_GENRES.find(g => g.id === song.genre);
        const moodInfo = SONG_MOODS.find(m => m.id === song.mood);
        const coWritingStyle = getLyricCoWritingStyle(song.lyricCoWritingStyle);
        const recentComments = song.comments.slice(-5);
        const collaborationContext = recentComments.length > 0
            ? `\n\n【最近的共创交流（只用于理解这首歌的讨论过程）】\n${recentComments.map(comment => {
                const speaker = comment.authorId === 'user' ? user.name : char.name;
                return `- ${speaker}：${comment.content}`;
            }).join('\n')}`
            : '';

        return `【已完成的作品】
歌名：《${song.title}》
风格：${genreInfo?.label || song.genre} | 情绪：${moodInfo?.label || song.mood}
共创写法：${coWritingStyle.label}

${buildLyricNotebookContext(song)}${collaborationContext}

【现在要说的话】
直接以${char.name}的口吻对${user.name}说3-4句话，不需要标题、项目符号或 JSON：
1. 引用一个具体词句，指出最有辨识度的画面或 Hook；
2. 评价结构推进、意象统一和可唱性；
3. 若仍有一个最值得精修的问题，明确说出位置和原因；若没有，不要强行挑错；
4. 最后自然地回应这次共同完成作品的时刻，把作品归还给${user.name}。
禁止只写“很有感染力、很有画面感、继续加油”这类没有依据的套话。`;
    }
};
