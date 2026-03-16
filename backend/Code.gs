/**
 * Google Apps Script (GAS) Code for VeggieRadar Project - Real-Time Search
 *
 * This script provides real-time produce price lookup by querying the
 * Taiwan Ministry of Agriculture API on demand.
 */

// --- Configuration ---
const AGRICULTURE_API_URL = "https://data.moa.gov.tw/Service/OpenData/FromM/AgriProductsTransType/";
const MOA_API_KEY = PropertiesService.getScriptProperties().getProperty('MOA_API_KEY');

// Load produce mapping data (lazy loaded)
let PRODUCE_MAPPING = null;

/**
 * Loads the produce mapping data from the external JSON file
 * @returns {Array} Array of {code, name} objects
 */
function getProduceMapping() {
  if (PRODUCE_MAPPING === null) {
    // In GAS, we need to embed the mapping data directly since we can't load external files
    // This will be populated from produce-mapping.json
    PRODUCE_MAPPING = [{"code":"LP2","name":"九層塔"},{"code":"LY4","name":"人參葉"},{"code":"FY017","name":"八角金盤"},{"code":"FH004","name":"八卦草(黃河)"},{"code":"FO007","name":"千代蘭"},{"code":"FH210","name":"夕霧草"},{"code":"SS0","name":"大心菜-其他"},{"code":"SS1","name":"大心菜-帶葉"},{"code":"FO331","name":"大文心蘭"},{"code":"FH375","name":"大飛燕草"},{"code":"FH311","name":"大理花-紅色"},{"code":"FH314","name":"大理花-粉色"},{"code":"FH310","name":"大理花-混色"},{"code":"FH312","name":"大理花-橘色"},{"code":"FH318","name":"大理花-雙色"},{"code":"FC000","name":"大菊"},{"code":"FC601","name":"大菊-日本白"},{"code":"FC302","name":"大菊-世界一"},{"code":"FC600","name":"大菊-白"},{"code":"FC616","name":"大菊-白牡丹"},{"code":"FC609","name":"大菊-白宮"},{"code":"FC614","name":"大菊-白鳥"},{"code":"FC604","name":"大菊-白鷺"},{"code":"FC615","name":"大菊-白露"},{"code":"FC608","name":"大菊-百里香"},{"code":"FC618","name":"大菊-光采"},{"code":"FC622","name":"大菊-克拉拉"},{"code":"FC605","name":"大菊-沙巴"},{"code":"FC631","name":"大菊-迪亞哥"},{"code":"FC613","name":"大菊-青峰"},{"code":"FC100","name":"大菊-紅"},{"code":"FC619","name":"大菊-紅小乖"},{"code":"FC620","name":"大菊-紅火"},{"code":"FC128","name":"大菊-紅妃"},{"code":"FC129","name":"大菊-紅花"},{"code":"FC101","name":"大菊-紅劍獅"},{"code":"FC114","name":"大菊-紅露"},{"code":"FC106","name":"大菊-秋胭"},{"code":"FC102","name":"大菊-紅懷寶"},{"code":"FC610","name":"大菊-祥雲"},{"code":"FC617","name":"大菊-笑聲"},{"code":"FC116","name":"大菊-馬約"},{"code":"FC621","name":"大菊-桃樂絲"},{"code":"FC300","name":"大菊-粉"},{"code":"FC305","name":"大菊-粉妃"},{"code":"FC309","name":"大菊-粉劍獅"},{"code":"FC632","name":"大菊-粉懷寶"},{"code":"FC330","name":"大菊-茴香"},{"code":"FC612","name":"大菊-貴妃"},{"code":"FC325","name":"大菊-雪花"},{"code":"FC206","name":"大菊-混色"},{"code":"FC200","name":"大菊-黃"},{"code":"FC217","name":"大菊-黃火"},{"code":"FC226","name":"大菊-黃妃"},{"code":"FC212","name":"大菊-黃花"},{"code":"FC205","name":"大菊-黃金"},{"code":"FC222","name":"大菊-黃劍獅"},{"code":"FC214","name":"大菊-黃秋"},{"code":"FC211","name":"大菊-黃秀"},{"code":"FC227","name":"大菊-黃懷寶"},{"code":"FC221","name":"大菊-黃露"},{"code":"FC209","name":"大菊-黃鶯"},{"code":"FC202","name":"大菊-閃點"},{"code":"FC623","name":"大菊-雅典娜"},{"code":"FC500","name":"大菊-雜色"},{"code":"FC611","name":"大菊-雷蒙德"},{"code":"FC628","name":"大菊-綠迪波"},{"code":"FC630","name":"大菊-綠迪亞哥"},{"code":"FC603","name":"大菊-精工"},{"code":"FC629","name":"大菊-瑪琳"},{"code":"FC400","name":"大菊-橙"},{"code":"FC404","name":"大菊-橙劍獅"},{"code":"FC406","name":"大菊-橙懷寶"},{"code":"FC505","name":"大菊-雙色"},{"code":"FC607","name":"大菊-歡喜"},{"code":"FC633","name":"大菊-耀眼"},{"code":"FC624","name":"大菊-魔術師"},{"code":"LW0","name":"大蒜-其他"},{"code":"LW1","name":"大蒜-硬梗"},{"code":"LW2","name":"大蒜-軟梗"},{"code":"LW9","name":"大蒜-蒜球"},{"code":"FL3","name":"大黃瓜-其他"},{"code":"FL1","name":"大黃瓜-刺黃瓜"},{"code":"FL2","name":"大黃瓜-花胡瓜"},{"code":"LDQ","name":"小白菜"},{"code":"74","name":"小番茄-玉女"},{"code":"70","name":"小番茄-其他"},{"code":"72","name":"小番茄-聖女"},{"code":"73","name":"小番茄-嬌女"},{"code":"71","name":"小番茄-ㄧ般"},{"code":"LCB","name":"小芥菜"},{"code":"53","name":"小松菜"},{"code":"LCR","name":"小洋芋(珍珠芋頭)"},{"code":"FT0","name":"小胡瓜-其他"},{"code":"FT1","name":"小胡瓜-醃瓜"},{"code":"LF0","name":"小黃瓜-其他"},{"code":"LF1","name":"小黃瓜-花胡瓜"},{"code":"LAP","name":"山茼蒿"},{"code":"FY213","name":"山蘇"},{"code":"LPU","name":"山藥-其他"},{"code":"LPT","name":"山藥-白皮白肉"},{"code":"LPS","name":"山藥-紅皮白肉"},{"code":"LPR","name":"山藥-紅皮紅肉"},{"code":"FY219","name":"山蘇花"},{"code":"FM0","name":"不結球白菜(小白菜)"},{"code":"FM1","name":"不結球白菜-其他"},{"code":"FY109","name":"五葉松"},{"code":"FD041","name":"五彩千年木"},{"code":"FY125","name":"五彩鳳梨"},{"code":"FH401","name":"六出花-紅"},{"code":"FH402","name":"六出花-橙"},{"code":"FH400","name":"六出花-混色"},{"code":"FH403","name":"六出花-黃"},{"code":"FH404","name":"六出花-粉"},{"code":"FH405","name":"六出花-白"},{"code":"FH416","name":"六出花-雙色"},{"code":"5V","name":"分蔥(紅蔥頭)"},{"code":"FH376","name":"天堂鳥"},{"code":"FD028","name":"太陽麻"},{"code":"52","name":"尤加利葉"},{"code":"FY009","name":"巴西鐵樹"},{"code":"FY124","name":"心葉蔓綠絨"},{"code":"FY024","name":"文竹"},{"code":"FD043","name":"文心蘭(觀賞葉)"},{"code":"FO300","name":"文心蘭"},{"code":"FO370","name":"文心蘭-串"},{"code":"FO302","name":"文心蘭-白"},{"code":"FO330","name":"文心蘭-姬文心蘭"},{"code":"FO332","name":"文心蘭-迷你文心蘭"},{"code":"FO306","name":"文心蘭-混色"},{"code":"FO305","name":"文心蘭-粉"},{"code":"FO303","name":"文心蘭-紫"},{"code":"FO304","name":"文心蘭-黃"},{"code":"FO399","name":"文心蘭-雜色"},{"code":"FD038","name":"文竹葉"},{"code":"FH217","name":"木百合"},{"code":"FY036","name":"木瓜葉"},{"code":"FY005","name":"本松葉"},{"code":"FO203","name":"朵麗蝶蘭"},{"code":"FY037","name":"本蕨葉"},{"code":"FH372","name":"火焰百合"},{"code":"FY306","name":"火鶴(葉)"},{"code":"FO610","name":"火鶴花-粉"},{"code":"FO600","name":"火鶴花-紅"},{"code":"FO630","name":"火鶴花-混色"},{"code":"FO620","name":"火鶴花-橙"},{"code":"FO660","name":"火鶴花-黃綠"},{"code":"FO640","name":"火鶴花-白"},{"code":"FO650","name":"火鶴花-綠"},{"code":"FY210","name":"玉羊齒"},{"code":"FH374","name":"玉米百合"},{"code":"FH601","name":"玫瑰(ESCIMO)"},{"code":"FH502","name":"玫瑰-粉"},{"code":"FH500","name":"玫瑰-紅"},{"code":"FH600","name":"玫瑰-混色"},{"code":"FH503","name":"玫瑰-橙"},{"code":"FH507","name":"玫瑰-黃"},{"code":"FH504","name":"玫瑰-雜色"},{"code":"FH506","name":"玫瑰-白"},{"code":"FH505","name":"玫瑰-綠"},{"code":"FY011","name":"白玉黛粉葉"},{"code":"FH373","name":"白頭翁"},{"code":"FY303","name":"白鶴芋"},{"code":"LCI","name":"甘藍-小包"},{"code":"LC1","name":"甘藍-改良種"},{"code":"LC3","name":"甘藍-其他"},{"code":"LC2","name":"甘藍-初秋"},{"code":"FY214","name":"石松"},{"code":"FH219","name":"石竹"},{"code":"FY126","name":"石斛蘭(葉)"},{"code":"FO800","name":"石斛蘭"},{"code":"FO830","name":"石斛蘭-白"},{"code":"FO810","name":"石斛蘭-紫"},{"code":"FO820","name":"石斛蘭-混色"},{"code":"FO870","name":"石斛蘭-粉"},{"code":"FO840","name":"石斛蘭-黃"},{"code":"FO880","name":"石斛蘭-雜色"},{"code":"FY029","name":"竹柏"},{"code":"FH213","name":"羽扇豆(魯冰花)"},{"code":"FY215","name":"羊齒"},{"code":"FH215","name":"老鼠簕"},{"code":"FO920","name":"蕙蘭"},{"code":"FH205","name":"西洋水仙"},{"code":"FY307","name":"貝母葉"},{"code":"FF051","name":"辛夷"},{"code":"FH212","name":"金杖球"},{"code":"FD200","name":"金露花-其他"},{"code":"FD201","name":"金露花-白斑"},{"code":"FD209","name":"金露花-紫葉"},{"code":"FD202","name":"金露花-綠葉"},{"code":"FD203","name":"金露花-黃斑"},{"code":"6C","name":"青江白菜"},{"code":"FH377","name":"青花椰菜"},{"code":"FY305","name":"青龍葉"},{"code":"LH0","name":"青蔥"},{"code":"LHL","name":"青蔥-濕"},{"code":"FY101","name":"非洲菊(葉)"},{"code":"FH100","name":"非洲菊-白"},{"code":"FH101","name":"非洲菊-紅"},{"code":"FH102","name":"非洲菊-粉"},{"code":"FH103","name":"非洲菊-橙"},{"code":"FH104","name":"非洲菊-黃"},{"code":"FH105","name":"非洲菊-混色"},{"code":"FH116","name":"非洲菊-雜色"},{"code":"FH200","name":"非洲鳳仙花"},{"code":"FO001","name":"香水百合"},{"code":"FO002","name":"香水百合-卡薩布蘭加"},{"code":"FO100","name":"香水百合-白"},{"code":"FO110","name":"香水百合-粉"},{"code":"FO111","name":"香水百合-粉紅"},{"code":"FO150","name":"香水百合-混色"},{"code":"FO120","name":"香水百合-黃"},{"code":"FO130","name":"香水百合-雙色"},{"code":"FH211","name":"香豌豆"},{"code":"FM3","name":"油菜"},{"code":"FY216","name":"武竹"},{"code":"FY003","name":"武竹葉"},{"code":"56","name":"玫瑰-紫"},{"code":"FJ3","name":"番茄-牛番茄"},{"code":"FJ0","name":"番茄-其他"},{"code":"FJ2","name":"番茄-粉柿"},{"code":"FJ1","name":"番茄-黑柿"},{"code":"FF105","name":"白玉蘭"},{"code":"FY110","name":"真柏"},{"code":"FO206","name":"神代蘭"},{"code":"FY301","name":"粗肋草-其他"},{"code":"FY302","name":"粗肋草-白肋"},{"code":"FO900","name":"素心蘭"},{"code":"FH204","name":"茶花"},{"code":"FD301","name":"茵蔯蒿"},{"code":"FO205","name":"迷你蝴蝶蘭"},{"code":"FY218","name":"高山羊齒"},{"code":"FH214","name":"高山龍膽"},{"code":"LLB","name":"高冷蔬菜-刈菜(芥菜)"},{"code":"LA0","name":"高麗菜"},{"code":"LAF","name":"高麗菜-初秋"},{"code":"LAC","name":"高麗菜-其他"},{"code":"LAD","name":"高麗菜-改良種"},{"code":"FY020","name":"假葉樹"},{"code":"FY023","name":"假櫻桃"},{"code":"FH602","name":"康乃馨(ESCIMO)"},{"code":"FA800","name":"康乃馨-多朵(混色)"},{"code":"FA801","name":"康乃馨-多朵(白)"},{"code":"FA802","name":"康乃馨-多朵(粉)"},{"code":"FA803","name":"康乃馨-多朵(紫)"},{"code":"FA804","name":"康乃馨-多朵(黃)"},{"code":"FA805","name":"康乃馨-多朵(紅)"},{"code":"FA900","name":"康乃馨-迷你康乃馨"},{"code":"FA130","name":"康乃馨-白心紅"},{"code":"FA100","name":"康乃馨-白"},{"code":"FA110","name":"康乃馨-桃"},{"code":"FA170","name":"康乃馨-混色"},{"code":"FA140","name":"康乃馨-紫"},{"code":"FA190","name":"康乃馨-深桃"},{"code":"FA401","name":"康乃馨-深粉"},{"code":"FA120","name":"康乃馨-淡粉"},{"code":"FA150","name":"康乃馨-雜色"},{"code":"FA160","name":"康乃馨-黃"},{"code":"FA199","name":"康乃馨-雙色"},{"code":"FA180","name":"康乃馨-綠"},{"code":"FA400","name":"康乃馨-橙"},{"code":"FA402","name":"康乃馨-粉"},{"code":"FA500","name":"康乃馨-紅"},{"code":"FY026","name":"雪松"},{"code":"FY123","name":"雪茄花"},{"code":"FH209","name":"鳥"},{"code":"FH208","name":"麒麟草"},{"code":"FH206","name":"麝香石竹"},{"code":"FD023","name":"傘草"},{"code":"FH603","name":"唐菖蒲"},{"code":"FY202","name":"圓葉小菊葉"},{"code":"FY122","name":"圓葉尤加利"},{"code":"FO201","name":"朵麗蝶蘭(小)"},{"code":"FY204","name":"彩葉草"},{"code":"FD044","name":"彩菊葉"},{"code":"FD037","name":"彩葉芋"},{"code":"FD035","name":"彩葉芋-白"},{"code":"FD034","name":"彩葉芋-粉紅"},{"code":"FD036","name":"彩葉芋-紫"},{"code":"FD033","name":"彩葉芋-綠"},{"code":"FY121","name":"斑葉"},{"code":"FD011","name":"斑葉山茱萸"},{"code":"FY030","name":"斑葉蘭"},{"code":"FD031","name":"朱蕉"},{"code":"FD032","name":"朱蕉-紅葉"},{"code":"FY217","name":"橄欖葉"},{"code":"FD048","name":"海桐"},{"code":"FD014","name":"火龍果花"},{"code":"FH601","name":"玫瑰-ESCIMO"},{"code":"FH300","name":"玫瑰-噴射玫瑰"},{"code":"FD001","name":"珊瑚蕨"},{"code":"FO004","name":"百合-白"},{"code":"FO040","name":"百合-混色"},{"code":"FO020","name":"百合-黃"},{"code":"FO030","name":"百合-雜色"},{"code":"FO010","name":"百合-粉"},{"code":"FD009","name":"百里香葉"},{"code":"FH216","name":"百日草"},{"code":"FY104","name":"竹葉"},{"code":"FY018","name":"羅漢松"},{"code":"FY103","name":"綬草"},{"code":"FD027","name":"繁星花"},{"code":"FD045","name":"翠菊葉"},{"code":"FD008","name":"迷迭香葉"},{"code":"LB5","name":"胡蘿蔔-其他"},{"code":"LB4","name":"胡蘿蔔-梅花鹿"},{"code":"LB2","name":"胡蘿蔔-粗大"},{"code":"LB3","name":"胡蘿蔔-洋種"},{"code":"FY201","name":"舞女蘭(葉)"},{"code":"FY127","name":"虎尾蘭"},{"code":"FH202","name":"虎眼"},{"code":"FY108","name":"蚌蘭"},{"code":"FD026","name":"袋鼠花"},{"code":"FH207","name":"金色菊"},{"code":"FY107","name":"金邊百合竹"},{"code":"FY010","name":"金邊富貴竹"},{"code":"FY001","name":"金黃孔雀竹芋"},{"code":"FY203","name":"金葉擬美花"},{"code":"FH371","name":"金針"},{"code":"FM2","name":"青江菜"},{"code":"FY022","name":"雲杉"},{"code":"FY220","name":"黃金串錢柳"},{"code":"FY025","name":"黃金側柏"},{"code":"FH220","name":"黃帝菊"},{"code":"FY221","name":"黃金綠珊瑚"},{"code":"FD019","name":"黃花"},{"code":"LCF","name":"黑豆芽"},{"code":"FY111","name":"黑松"},{"code":"FD025","name":"黑種草"},{"code":"FY222","name":"黑葉觀音蓮"},{"code":"FD030","name":"傳統萬年青"},{"code":"LCU","name":"慈姑"},{"code":"FD005","name":"新西蘭葉"},{"code":"FY206","name":"新葉菊"},{"code":"FD003","name":"椰子葉"},{"code":"FY128","name":"椒草"},{"code":"FH600","name":"溫室玫瑰"},{"code":"FH603","name":"溫室玫瑰-ESCIMO"},{"code":"FO202","name":"溫室蝴蝶蘭"},{"code":"FY102","name":"番仔林投"},{"code":"FH218","name":"節節花"},{"code":"FY002","name":"葉蘭"},{"code":"FO900","name":"跳舞蘭"},{"code":"FY212","name":"電信蘭葉"},{"code":"FY205","name":"綠珊瑚"},{"code":"FH203","name":"萬壽菊"},{"code":"FD017","name":"蓮蕉"},{"code":"FY207","name":"銀杏"},{"code":"FD002","name":"銀河葉"},{"code":"FD020","name":"銀葉菊"},{"code":"FY019","name":"榕樹葉"},{"code":"FD010","name":"滿天星(觀葉)"},{"code":"FH604","name":"滿天星"},{"code":"FH379","name":"滿天星-白"},{"code":"FH378","name":"滿天星-粉"},{"code":"FF008","name":"百合(OT系)"},{"code":"FY211","name":"瑪莉亞"},{"code":"FF101","name":"瑪格麗特"},{"code":"FF100","name":"繡球花"},{"code":"FF103","name":"繡球花-白"},{"code":"FF106","name":"繡球花-多色"},{"code":"FF102","name":"繡球花-粉"},{"code":"FF104","name":"繡球花-藍"},{"code":"FF107","name":"繡球花-雜色"},{"code":"FH313","name":"翠珠"},{"code":"FY105","name":"蕨類"},{"code":"FY004","name":"蕨類葉"},{"code":"FY106","name":"蕨類葉-長葉兔腳蕨"},{"code":"FY100","name":"蝴蝶蘭(葉)"},{"code":"FO200","name":"蝴蝶蘭"},{"code":"FO230","name":"蝴蝶蘭-白"},{"code":"FO250","name":"蝴蝶蘭-紫"},{"code":"FO260","name":"蝴蝶蘭-混色"},{"code":"FO240","name":"蝴蝶蘭-粉"},{"code":"FO270","name":"蝴蝶蘭-黃"},{"code":"FO280","name":"蝴蝶蘭-雜色"},{"code":"FY112","name":"鋸齒蘭"},{"code":"FH315","name":"鋸齒蘭"},{"code":"FY304","name":"龍柏"},{"code":"FD004","name":"龍柏葉"},{"code":"FD015","name":"龍船花"},{"code":"FD006","name":"龍葵葉"},{"code":"FD013","name":"優雅藍"},{"code":"LLF","name":"濕韭菜(韭菜花)"},{"code":"FH316","name":"燈臺花"},{"code":"FY113","name":"龜背芋"},{"code":"FD018","name":"繡球撫子(花)"},{"code":"FA985","name":"繡球撫子-綠石竹"},{"code":"FA980","name":"繡球撫子-白"},{"code":"FA981","name":"繡球撫子-粉"},{"code":"FA983","name":"繡球撫子-紫"},{"code":"FA982","name":"繡球撫子-雙色"},{"code":"FA984","name":"繡球撫子-雜色"},{"code":"FD047","name":"薔薇葉"},{"code":"FD039","name":"薰衣草葉"},{"code":"LM1","name":"韭菜"},{"code":"LM2","name":"韭菜-乾"},{"code":"LM0","name":"韭菜-韭黃"},{"code":"FD040","name":"蟛蜞菊葉"},{"code":"FO204","name":"豹紋蘭"},{"code":"FY119","name":"鐵線蕨"},{"code":"FD041","name":"鏡面草"},{"code":"FO006","name":"鐵炮百合"},{"code":"FD012","name":"鐵樹"},{"code":"FD016","name":"藍莓花"},{"code":"FH221","name":"雞冠花"},{"code":"FY114","name":"觀音竹"},{"code":"FD024","name":"觀音竹葉"},{"code":"FY027","name":"觀賞鳳梨"},{"code":"FY115","name":"觀賞鳳梨(葉)"},{"code":"FH317","name":"蘋婆"},{"code":"FD046","name":"變葉木"},{"code":"FD029","name":"鑽石黃金葛"},{"code":"FY116","name":"鐘乳石"},{"code":"FY208","name":"雞毛撢子"},{"code":"FY209","name":"蘆竹"},{"code":"FY028","name":"蘆筍(葉)"},{"code":"LR0","name":"蘆筍"},{"code":"FY031","name":"鐵木"},{"code":"FY032","name":"鐵樹葉"},{"code":"FD007","name":"蘿蔔花"},{"code":"FY006","name":"變葉木葉"},{"code":"FD042","name":"鐵線蓮"},{"code":"FY033","name":"變色木葉"},{"code":"FY034","name":"欖仁"},{"code":"FY035","name":"闊葉武竹"},{"code":"FD021","name":"蘭花草"},{"code":"FD022","name":"鱷魚花"}];
  }
  return PRODUCE_MAPPING;
}

/**
 * Fuzzy search for crop names based on user input
 * @param {string} userInput - User's search query
 * @returns {Array} Array of matched crop names (exact names for API calls)
 */
function fuzzySearchCropNames(userInput) {
  if (!userInput || userInput.trim() === '') {
    return [];
  }

  const mapping = getProduceMapping();
  const normalizedInput = userInput.trim();

  // Strategy 1: Exact match
  const exactMatches = mapping.filter(crop => crop.name === normalizedInput);
  if (exactMatches.length > 0) {
    Logger.log(`Found ${exactMatches.length} exact matches for "${normalizedInput}"`);
    return exactMatches.map(crop => crop.name);
  }

  // Strategy 2: Starts with input
  const startsWithMatches = mapping.filter(crop => crop.name.indexOf(normalizedInput) === 0);
  if (startsWithMatches.length > 0) {
    Logger.log(`Found ${startsWithMatches.length} crops starting with "${normalizedInput}"`);
    return startsWithMatches.map(crop => crop.name);
  }

  // Strategy 3: Contains input
  const containsMatches = mapping.filter(crop => crop.name.indexOf(normalizedInput) !== -1);
  if (containsMatches.length > 0) {
    Logger.log(`Found ${containsMatches.length} crops containing "${normalizedInput}"`);
    return containsMatches.map(crop => crop.name);
  }

  // Strategy 4: Character-by-character fuzzy matching
  const fuzzyMatches = mapping.filter(crop => {
    let inputIndex = 0;
    for (let i = 0; i < crop.name.length && inputIndex < normalizedInput.length; i++) {
      if (crop.name[i] === normalizedInput[inputIndex]) {
        inputIndex++;
      }
    }
    return inputIndex === normalizedInput.length;
  });

  if (fuzzyMatches.length > 0) {
    Logger.log(`Found ${fuzzyMatches.length} crops with fuzzy matching for "${normalizedInput}"`);
    return fuzzyMatches.map(crop => crop.name);
  }

  Logger.log(`No matches found for "${normalizedInput}"`);
  return [];
}

// --- Main Web App Entry Point ---
function doGet(e) {
  try {
    // Get query parameter from request
    const query = e.parameter.query || '';

    if (!query) {
      return ContentService.createTextOutput(JSON.stringify({
        error: "請提供查詢關鍵字",
        message: "使用方式：?query=高麗菜"
      }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 1. Use fuzzy search to find matching crop names
    const matchedCropNames = fuzzySearchCropNames(query);

    if (matchedCropNames.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        error: "查無此品項",
        query: query,
        suggestion: "請嘗試其他關鍵字，例如：高麗菜、番茄、青江菜"
      }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    Logger.log(`Found ${matchedCropNames.length} matching crops: ${matchedCropNames.join(', ')}`);

    // 2. Fetch real-time data from Agriculture API for all matched crops
    let allTodayData = [];
    let allYesterdayData = [];

    for (let i = 0; i < matchedCropNames.length; i++) {
      const cropName = matchedCropNames[i];
      const { todayData, yesterdayData } = fetchRealTimeData(cropName);
      allTodayData = allTodayData.concat(todayData);
      allYesterdayData = allYesterdayData.concat(yesterdayData);
    }

    const todayData = allTodayData;
    const yesterdayData = allYesterdayData;

    if (todayData.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        error: "查無此品項",
        query: query
      }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Process matched items (calculate change_percent, filter low volume)
    const processedItems = processSearchResults(todayData, yesterdayData);

    if (processedItems.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        error: "查無符合條件的品項（可能交易量過低）",
        query: query
      }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. Construct the final JSON response
    const currentDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    const responseData = {
      query: query,
      date: currentDate,
      count: processedItems.length,
      items: processedItems
    };

    return ContentService.createTextOutput(JSON.stringify(responseData))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log("Error in doGet: " + error.toString());
    return ContentService.createTextOutput(JSON.stringify({
      error: "系統錯誤",
      message: error.message
    }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Fetches real-time data from Agriculture API for today and yesterday
 * @param {string} cropName - Crop name to search for
 * @returns {Object} Object containing todayData and yesterdayData arrays
 */
function fetchRealTimeData(cropName) {
  Logger.log(`Fetching real-time agriculture data for: ${cropName}`);

  // Calculate date range (today and yesterday for price comparison)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const todayStr = formatDateForAPI(today);
  const yesterdayStr = formatDateForAPI(yesterday);

  // Fetch today's data with crop name filter
  const todayData = fetchDataByCropName(cropName, todayStr, todayStr);
  Logger.log(`Fetched ${todayData.length} items for today (${todayStr})`);

  // Fetch yesterday's data for price comparison
  const yesterdayData = fetchDataByCropName(cropName, yesterdayStr, yesterdayStr);
  Logger.log(`Fetched ${yesterdayData.length} items for yesterday (${yesterdayStr})`);

  return { todayData, yesterdayData };
}

/**
 * Fetches data from Agriculture API for a specific crop name and date range
 * @param {string} cropName - Crop name to search for
 * @param {string} startTime - Start date in format "111.01.01" (ROC calendar)
 * @param {string} endTime - End date in format "111.01.01" (ROC calendar)
 * @returns {Array} Array of agricultural product data
 */
function fetchDataByCropName(cropName, startTime, endTime) {
  const allData = [];
  let page = null;
  let hasMoreData = true;

  // Fetch data with pagination
  while (hasMoreData) {
    // Build query parameters
    const params = {
      CropName: cropName,
      Start_time: startTime,
      End_time: endTime
    };

    // Add page parameter if exists
    if (page) {
      params.Page = page;
    }

    // Build URL with query parameters
    const url = buildURLWithParams(AGRICULTURE_API_URL, params);

    Logger.log(`Fetching URL: ${url}`);

    try {
      const response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true
        // Remove Authorization header - this API doesn't require it
      });

      const responseText = response.getContentText();
      Logger.log(`Response status: ${response.getResponseCode()}`);
      Logger.log(`Response preview: ${responseText.substring(0, 200)}`);

      const result = JSON.parse(responseText);

      // Check if data exists
      if (result.Data && result.Data.length > 0) {
        allData.push(...result.Data);

        // Check if there's more data
        if (result.Next === true && result.Page) {
          page = result.Page;
          Utilities.sleep(100); // Rate limiting
        } else {
          hasMoreData = false;
        }
      } else {
        hasMoreData = false;
      }

    } catch (error) {
      Logger.log(`Error fetching data for ${cropName}: ${error.toString()}`);
      hasMoreData = false;
    }
  }

  return allData;
}

/**
 * Builds a URL with query parameters
 * @param {string} baseUrl - Base URL
 * @param {Object} params - Object with query parameters
 * @returns {string} Complete URL with query string
 */
function buildURLWithParams(baseUrl, params) {
  const queryString = Object.keys(params)
    .filter(key => params[key] !== null && params[key] !== undefined)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');

  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

/**
 * Formats a Date object to ROC calendar format for API (e.g., "115.03.16")
 * @param {Date} date - JavaScript Date object
 * @returns {string} Date string in ROC calendar format
 */
function formatDateForAPI(date) {
  const year = date.getFullYear() - 1911; // Convert to ROC year
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}.${month}.${day}`;
}

/**
 * Processes search results: calculate price changes, filter low volume
 * @param {Array} todayItems - Today's matched items
 * @param {Array} yesterdayData - Yesterday's full data for comparison
 * @returns {Array} Processed items ready for response
 */
function processSearchResults(todayItems, yesterdayData) {
  Logger.log("Processing search results...");
  const processed = [];
  const MIN_TRADE_VOLUME = 200; // Minimum trade volume threshold

  // Create a map of yesterday's prices by crop code and market
  const yesterdayPriceMap = {};
  yesterdayData.forEach(item => {
    const key = `${item.CropCode}_${item.MarketName}`;
    yesterdayPriceMap[key] = parseFloat(item.Avg_Price || 0);
  });

  todayItems.forEach(item => {
    // Parse trade volume
    const tradeVolume = parseFloat(item.Trans_Quantity || 0);

    // Filter out items with low trade volume
    if (tradeVolume < MIN_TRADE_VOLUME) {
      Logger.log(`Skipping ${item.CropName} due to low trade volume (${tradeVolume})`);
      return;
    }

    // Parse today's average price
    const avgPrice = parseFloat(item.Avg_Price || 0);
    if (avgPrice === 0) {
      return; // Skip items with no price data
    }

    // Calculate price change percentage
    const key = `${item.CropCode}_${item.MarketName}`;
    const yesterdayPrice = yesterdayPriceMap[key] || avgPrice;
    let changePercent = 0;

    if (yesterdayPrice > 0 && yesterdayPrice !== avgPrice) {
      changePercent = ((avgPrice - yesterdayPrice) / yesterdayPrice) * 100;
    }

    // Determine unit (公斤 is default)
    const unit = '公斤'; // API uses 元/公斤 for pricing

    processed.push({
      code: item.CropCode || '',
      name: item.CropName || '',
      avg_price: parseFloat(avgPrice.toFixed(1)),
      change_percent: parseFloat(changePercent.toFixed(1)),
      trade_volume: tradeVolume,
      category: item.TcType || '',
      origin: '', // Not provided in this API response
      unit: unit,
      market: item.MarketName || '',
      upper_price: parseFloat(item.Upper_Price || 0),
      middle_price: parseFloat(item.Middle_Price || 0),
      lower_price: parseFloat(item.Lower_Price || 0)
    });
  });

  Logger.log(`Processed ${processed.length} items after filtering`);
  return processed;
}

/**
 * Placeholder for doPost function (for future Line Bot Webhook)
 */
function doPost(e) {
  Logger.log("doPost received: " + JSON.stringify(e));
  return ContentService.createTextOutput(JSON.stringify({
    status: "success",
    message: "doPost placeholder"
  }))
    .setMimeType(ContentService.MimeType.JSON);
}
