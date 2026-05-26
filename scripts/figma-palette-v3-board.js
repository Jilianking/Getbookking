// Paste this entire file into use_figma `code` (fileKey: 7s9TtmBgyANcfyhqI0z9lc)
// skillNames: figma-use
// Builds "Palette review board (v3)" below existing v2 board on the Palette page.

await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });

function hex(h) {
  const x = String(h).replace('#', '');
  return {
    r: parseInt(x.slice(0, 2), 16) / 255,
    g: parseInt(x.slice(2, 4), 16) / 255,
    b: parseInt(x.slice(4, 6), 16) / 255
  };
}

const PALETTES = [{"name":"Forest Sage","families":{"Classic":["#F4F7F4","#F4F7F4","#4A7C59","#D8E4D6","#1E2E24"],"Luxe":["#F2F6F1","#F2F6F1","#5B8268","#D5E2D2","#243528"],"Blade":["#0E1410","#0E1410","#6B9E7A","#1A241E","#1A241E"],"Stonecut":["#0A100C","#0A100C","#5A8A68","#141C16","#141C16"],"Studio 12":["#F3F7F2","#F3F7F2","#5A8266","#D6E3D4","#243628"]}},{"name":"Midnight Plum","families":{"Classic":["#FAF8FC","#FAF8FC","#6B4F8C","#E8E0F0","#2A1F38"],"Luxe":["#F9F6FB","#F9F6FB","#7A5C9E","#E5DBF0","#322448"],"Blade":["#120E18","#120E18","#9B7AB8","#1E1828","#1E1828"],"Stonecut":["#0C0810","#0C0810","#8A68A8","#181220","#181220"],"Studio 12":["#F8F5FA","#F8F5FA","#7258A0","#E6DCF0","#2E2240"]}},{"name":"Coral Bloom","families":{"Classic":["#FFF9F7","#FFF9F7","#E07A62","#F5E0DA","#3A2824"],"Luxe":["#FFF8F5","#FFF8F5","#D8866E","#F2DDD4","#402E28"],"Blade":["#1A100E","#1A100E","#E89078","#2A1C18","#2A1C18"],"Stonecut":["#140C0A","#140C0A","#D07058","#221816","#221816"],"Studio 12":["#FFF7F4","#FFF7F4","#D47A64","#F0D8D0","#3C2A24"]}},{"name":"Arctic Mist","families":{"Classic":["#F6FAFC","#F6FAFC","#5A8CA8","#DCE8F0","#1E2A36"],"Luxe":["#F4F9FB","#F4F9FB","#6A96B0","#D8E6F0","#243240"],"Blade":["#0E1418","#0E1418","#78A8C4","#1A242C","#1A242C"],"Stonecut":["#0A1014","#0A1014","#6898B4","#161E26","#161E26"],"Studio 12":["#F5FAFC","#F5FAFC","#5E90AC","#D6E6F0","#263442"]}},{"name":"Copper Ledger","families":{"Classic":["#FBF7F2","#FBF7F2","#B87333","#E8D9C8","#3A2E22"],"Luxe":["#FAF6F0","#FAF6F0","#C48A42","#E6D4C0","#3E3024"],"Blade":["#18120C","#18120C","#D4A050","#261E14","#261E14"],"Stonecut":["#100C08","#100C08","#B87830","#1C1610","#1C1610"],"Studio 12":["#FAF7F0","#FAF7F0","#B07038","#E4D4C0","#382C20"]}},{"name":"Lavender Haze","families":{"Classic":["#F9F8FC","#F9F8FC","#8A7AA8","#E4E0EE","#343040"],"Luxe":["#F8F6FA","#F8F6FA","#9A88B4","#E0DAEA","#38324A"],"Blade":["#141218","#141218","#A894C8","#221E2A","#221E2A"],"Stonecut":["#0E0C12","#0E0C12","#9480B0","#1A1822","#1A1822"],"Studio 12":["#F7F6FA","#F7F6FA","#8878A0","#E2DEE8","#363042"]}},{"name":"Olive Grove","families":{"Classic":["#F6F5F0","#F6F5F0","#7A7648","#E2DCC8","#2E2C22"],"Luxe":["#F5F4EE","#F5F4EE","#8A8654","#DED8C4","#343028"],"Blade":["#121410","#121410","#A8A468","#1E2018","#1E2018"],"Stonecut":["#0E100C","#0E100C","#949058","#1A1C14","#1A1C14"],"Studio 12":["#F4F3EC","#F4F3EC","#7E7A4C","#DCD6C0","#302E24"]}},{"name":"Rose Quartz","families":{"Classic":["#FCF7F8","#FCF7F8","#C48A96","#F0E0E4","#3A2C30"],"Luxe":["#FBF6F7","#FBF6F7","#D098A4","#ECD8DC","#403034"],"Blade":["#181214","#181214","#E0A0AC","#261C20","#261C20"],"Stonecut":["#120E10","#120E10","#C88898","#20181C","#20181C"],"Studio 12":["#FAF6F7","#FAF6F7","#B88490","#E8D6DA","#3C2E32"]}},{"name":"Graphite Mint","families":{"Classic":["#F4F6F6","#F4F6F6","#3D8A7A","#D8E4E2","#1E2826"],"Luxe":["#F2F5F4","#F2F5F4","#4A9484","#D4E2DE","#24302C"],"Blade":["#0C1010","#0C1010","#5CB8A4","#161E1C","#161E1C"],"Stonecut":["#080C0C","#080C0C","#50A890","#121A18","#121A18"],"Studio 12":["#F3F6F5","#F3F6F5","#468878","#D2E0DC","#222E2A"]}},{"name":"Honey Linen","families":{"Classic":["#FBF8F0","#FBF8F0","#C9A030","#F0E4C8","#3A3220"],"Luxe":["#FAF6EE","#FAF6EE","#D4AC40","#EDE0C4","#3E3424"],"Blade":["#16140C","#16140C","#E8C050","#242018","#242018"],"Stonecut":["#100E08","#100E08","#C09838","#1C1A12","#1C1A12"],"Studio 12":["#FAF7EE","#FAF7EE","#B89438","#E8DCC0","#383020"]}},{"name":"Baltic Blue","families":{"Classic":["#F4F7FA","#F4F7FA","#2E5A88","#D4E0EC","#1A2838"],"Luxe":["#F2F6FA","#F2F6FA","#3A6898","#D0DEE8","#1E3044"],"Blade":["#0A1018","#0A1018","#5A8CC0","#141C28","#141C28"],"Stonecut":["#080C14","#080C14","#4A7CB0","#121820","#121820"],"Studio 12":["#F3F7FA","#F3F7FA","#346890","#CEDCE8","#1C2C3C"]}},{"name":"Terracotta Clay","families":{"Classic":["#FAF5F0","#FAF5F0","#C06840","#E8D4C4","#3A2A1E"],"Luxe":["#F9F4EE","#F9F4EE","#CC7850","#E4D0BE","#3E2C20"],"Blade":["#18100C","#18100C","#D88058","#281C14","#281C14"],"Stonecut":["#120C08","#120C08","#C07048","#201812","#201812"],"Studio 12":["#F8F3EC","#F8F3EC","#B86C48","#E2CCB8","#38281C"]}},{"name":"Pearl Ash","families":{"Classic":["#F6F7F8","#F6F7F8","#6A7888","#E2E6EA","#2C3238"],"Luxe":["#F4F6F8","#F4F6F8","#788898","#DEE4EA","#303840"],"Blade":["#101214","#101214","#94A4B4","#1C1E22","#1C1E22"],"Stonecut":["#0C0E10","#0C0E10","#8494A4","#181A1E","#181A1E"],"Studio 12":["#F5F6F8","#F5F6F8","#6E7C8C","#DEE2E8","#2A3038"]}},{"name":"Berry Noir","families":{"Classic":["#FAF6F8","#FAF6F8","#8E4868","#E8DCE4","#2E1E28"],"Luxe":["#F9F5F7","#F9F5F7","#A05878","#E4D6E0","#342030"],"Blade":["#140C10","#140C10","#C07090","#22141C","#22141C"],"Stonecut":["#0E080C","#0E080C","#A86888","#1A1016","#1A1016"],"Studio 12":["#F8F4F6","#F8F4F6","#905870","#E2D4DC","#301C28"]}},{"name":"Sage Steam","families":{"Classic":["#F5F8F6","#F5F8F6","#6A9078","#DEE8E2","#28302A"],"Luxe":["#F3F7F4","#F3F7F4","#7A9E88","#DAE6DE","#2C342E"],"Blade":["#0E1210","#0E1210","#88B098","#1A201C","#1A201C"],"Stonecut":["#0A0E0C","#0A0E0C","#78A088","#161C18","#161C18"],"Studio 12":["#F4F8F5","#F4F8F5","#689078","#DCE8E0","#2A322C"]}}];
const FAMILIES = ['Classic', 'Luxe', 'Blade', 'Stonecut', 'Studio 12'];

const CARD_W = 196;
const CARD_H = 86;
const STRIP_H = 28;
const GAP_X = 12;
const GAP_Y = 16;
const LABEL_W = 128;

let page = figma.root.children.find(function(p) {
  return p.name.indexOf('Palette') >= 0 || p.name.indexOf('v2') >= 0;
});
if (!page) page = figma.currentPage;
await figma.setCurrentPageAsync(page);

var maxY = 0;
for (var i = 0; i < page.children.length; i++) {
  var n = page.children[i];
  if ('y' in n && 'height' in n) maxY = Math.max(maxY, n.y + n.height);
}
var startX = 0;
var startY = maxY > 0 ? maxY + 100 : 0;

var title = figma.createText();
title.fontName = { family: 'Inter', style: 'Semi Bold' };
title.characters = 'Palette review board (v3) — 15 additions';
title.fontSize = 26;
title.fills = [{ type: 'SOLID', color: hex('#1a1a1a') }];
title.x = startX;
title.y = startY;
page.appendChild(title);

var sub = figma.createText();
sub.fontName = { family: 'Inter', style: 'Regular' };
sub.characters = 'Bookking palettes v3 — 15 new presets × 5 template families (additive to v2).';
sub.fontSize = 12;
sub.fills = [{ type: 'SOLID', color: hex('#555555') }];
sub.x = startX;
sub.y = startY + 36;
page.appendChild(sub);

var y = startY + 72;
var createdNodeIds = [title.id, sub.id];

for (var pi = 0; pi < PALETTES.length; pi++) {
  var palette = PALETTES[pi];
  var row = figma.createFrame();
  row.name = 'Row / ' + palette.name;
  row.layoutMode = 'HORIZONTAL';
  row.primaryAxisAlignItems = 'MIN';
  row.counterAxisAlignItems = 'CENTER';
  row.itemSpacing = GAP_X;
  row.fills = [];
  row.x = startX;
  row.y = y;
  page.appendChild(row);

  var label = figma.createText();
  label.fontName = { family: 'Inter', style: 'Semi Bold' };
  label.characters = palette.name;
  label.fontSize = 11;
  label.fills = [{ type: 'SOLID', color: hex('#1a1a1a') }];
  row.appendChild(label);

  for (var fi = 0; fi < FAMILIES.length; fi++) {
    var fam = FAMILIES[fi];
    var strip = palette.families[fam];
    var card = figma.createFrame();
    card.name = fam + ' / ' + palette.name;
    card.layoutMode = 'VERTICAL';
    card.itemSpacing = 6;
    card.paddingTop = 8;
    card.paddingBottom = 8;
    card.paddingLeft = 10;
    card.paddingRight = 10;
    card.fills = [{ type: 'SOLID', color: hex('#ffffff') }];
    card.strokes = [{ type: 'SOLID', color: hex('#dddddd') }];
    card.strokeWeight = 1;
    card.cornerRadius = 8;
    card.resize(CARD_W, CARD_H);
    row.appendChild(card);

    var stripRow = figma.createFrame();
    stripRow.name = 'strip';
    stripRow.layoutMode = 'HORIZONTAL';
    stripRow.itemSpacing = 0;
    stripRow.fills = [];
    stripRow.resize(CARD_W - 20, STRIP_H);
    card.appendChild(stripRow);

    var segW = (CARD_W - 20) / 5;
    for (var si = 0; si < 5; si++) {
      var seg = figma.createRectangle();
      seg.resize(segW, STRIP_H);
      seg.fills = [{ type: 'SOLID', color: hex(strip[si]) }];
      if (si === 0) {
        seg.topLeftRadius = 4;
        seg.bottomLeftRadius = 4;
      }
      if (si === 4) {
        seg.topRightRadius = 4;
        seg.bottomRightRadius = 4;
      }
      stripRow.appendChild(seg);
    }

    var cap = figma.createText();
    cap.fontName = { family: 'Inter', style: 'Regular' };
    cap.characters = fam;
    cap.fontSize = 9;
    cap.fills = [{ type: 'SOLID', color: hex('#666666') }];
    card.appendChild(cap);
    createdNodeIds.push(card.id);
  }
  createdNodeIds.push(row.id);
  y += CARD_H + GAP_Y;
}

return {
  pageId: page.id,
  pageName: page.name,
  paletteRows: PALETTES.length,
  createdCount: createdNodeIds.length,
  startY: startY
};
