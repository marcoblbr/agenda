/*
 * Agenda do Marco: página só de leitura.
 *
 * Lê dados/ocupado.enc.json (gerado e CIFRADO pelo app Contatos no Mac), decifra
 * no navegador com a senha que o visitante digita (WebCrypto: PBKDF2-SHA256 +
 * AES-256-GCM) e mostra apenas os intervalos OCUPADOS, já mesclados. Antes de
 * decifrar, nada da agenda aparece na tela. A senha nunca vai para o servidor:
 * fica só no localStorage do navegador de quem a digitou (agendaMarco.senha).
 * Nenhum título, local, participante ou identificador de evento existe nem no
 * texto aberto, com UMA exceção: as reuniões marcadas pelo dono (hoje a
 * etiqueta "NASA", chave "thais") chegam em "highlights" com título e horário,
 * e "tags" diz o nome da etiqueta. Elas aparecem em azul com o nome da reunião,
 * e o botão da etiqueta no topo filtra só os dias com essas calls, de hoje em
 * diante.
 *
 * Os horários do JSON são minutos de relógio de parede no fuso da agenda
 * (America/Sao_Paulo). A página não faz conta de fuso: só usa Intl para
 * descobrir "que dia e que horas são agora" naquele fuso.
 *
 * Datas yyyy-MM-dd viram "números de dia" (dias desde 1970-01-01 em UTC), com
 * Date.UTC. Nunca new Date('yyyy-MM-dd'), que depende do fuso do navegador.
 *
 * A lógica pura fica em AgendaCore (window.AgendaCore e module.exports), para
 * ser testada no Node sem navegador.
 */
(function (global) {
  'use strict';

  var DAY_MS = 86400000;
  var MINUTES_IN_DAY = 1440;
  var STALE_MS = 24 * 60 * 60 * 1000;
  // A agenda mostra só das 09:00 às 20:00: antes e depois disso o Marco não faz
  // reunião. Nada fora dessa janela é desenhado (grade, lista do celular), seja
  // qual for o JSON. Única exceção: o TEXTO de uma reunião em destaque (NASA)
  // mostra o horário real dela, mesmo começando antes das 09:00 ou passando das
  // 20:00 (o Marco quer saber a hora de verdade); o bloco desenhado é que é cortado.
  var DAY_START = 9 * 60;
  var DAY_END = 20 * 60;
  var DEFAULT_WORK_HOURS = { start: DAY_START, end: DAY_END, weekdays: [1, 2, 3, 4, 5] };
  var NOW_STEP = 15;
  var MIN_FREE_LISTED = 15;

  var WEEKDAYS_SHORT = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
  var WEEKDAYS_LONG = ['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira',
    'sexta-feira', 'sábado', 'domingo'];
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
    'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  // ------------------------------------------------------------------ datas

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 'yyyy-MM-dd' -> número do dia (UTC). NaN se inválido (ex.: 2026-02-30). */
  function parseDay(value) {
    if (typeof value !== 'string') return NaN;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) return NaN;
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = Date.UTC(y, mo - 1, d);
    var check = new Date(t);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
      return NaN;
    }
    return Math.round(t / DAY_MS);
  }

  function dayParts(n) {
    var d = new Date(n * DAY_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }

  function formatDay(n) {
    var p = dayParts(n);
    var y = String(p.y);
    while (y.length < 4) y = '0' + y;
    return y + '-' + pad2(p.m) + '-' + pad2(p.d);
  }

  function toDayNumber(value) {
    if (typeof value === 'number') return isFinite(value) ? Math.round(value) : NaN;
    return parseDay(value);
  }

  /** Dia da semana ISO: 1 = segunda ... 7 = domingo. 1970-01-01 foi quinta (4). */
  function isoWeekday(n) {
    return ((((n % 7) + 7) % 7) + 3) % 7 + 1;
  }

  /** Quantos dias a tabela mostra: 6, nunca domingo (segunda a sábado, ou a partir de hoje). */
  var VIEW_DAYS = 6;

  /**
   * Os 6 dias mostrados a partir de start, pulando domingos. Seis dias sem
   * domingo cobrem sempre 7 dias de calendário, então andar 7 dias emenda uma
   * tela na outra, sem buraco nem repetição.
   */
  function viewDays(start) {
    var out = [];
    for (var n = start; out.length < VIEW_DAYS; n++) {
      if (isoWeekday(n) !== 7) out.push(n);
    }
    return out;
  }

  /**
   * Segunda-feira da semana de SEGUNDA A DOMINGO que contém n: o domingo fica
   * na semana que termina nele (domingo 18/10 -> segunda 12/10). É a semana
   * da barra "Nova semana" (weekBreaks).
   */
  function mondayOf(n) {
    return n - (isoWeekday(n) - 1);
  }

  /**
   * Onde começa uma semana nova na lista de dias mostrados: true no dia que é
   * de outra semana (segunda a domingo) que o dia anterior da lista; o
   * primeiro, nunca. Sem filtro isso é a segunda depois do sábado; com filtro,
   * qualquer par de dias de semanas diferentes. A página desenha ali a barra
   * "Nova semana".
   */
  function weekBreaks(days) {
    return days.map(function (n, i) { return i > 0 && mondayOf(n) !== mondayOf(days[i - 1]); });
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  // -------------------------------------------------------------- intervalos

  /** Ordena, recorta em [0,1440], descarta inválidos e funde sobrepostos/encostados. */
  function mergeIntervals(list) {
    if (!Array.isArray(list)) return [];
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      var iv = list[i];
      if (!Array.isArray(iv) || iv.length < 2) continue;
      var s = Number(iv[0]), e = Number(iv[1]);
      if (!isFinite(s) || !isFinite(e)) continue;
      s = clamp(Math.round(s), 0, MINUTES_IN_DAY);
      e = clamp(Math.round(e), 0, MINUTES_IN_DAY);
      if (e > s) arr.push([s, e]);
    }
    arr.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var out = [];
    for (var j = 0; j < arr.length; j++) {
      var last = out[out.length - 1];
      if (last && arr[j][0] <= last[1]) {
        if (arr[j][1] > last[1]) last[1] = arr[j][1];
      } else {
        out.push([arr[j][0], arr[j][1]]);
      }
    }
    return out;
  }

  /** Livre = complemento do ocupado dentro de [from, to). */
  function complement(busy, from, to) {
    var free = [];
    if (!(to > from)) return free;
    var merged = mergeIntervals(busy);
    var cursor = from;
    for (var i = 0; i < merged.length; i++) {
      var s = merged[i][0], e = merged[i][1];
      if (e <= cursor) continue;
      if (s >= to) break;
      if (s > cursor) free.push([cursor, s]);
      if (e > cursor) cursor = e;
      if (cursor >= to) break;
    }
    if (cursor < to) free.push([cursor, to]);
    return free;
  }

  // ------------------------------------------------------------------- dados

  function toMinute(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    var m = Math.round(value);
    return m >= 0 && m <= MINUTES_IN_DAY ? m : null;
  }

  function isIsoWeekdayValue(v) {
    return typeof v === 'number' && v >= 1 && v <= 7 && Math.round(v) === v;
  }

  /**
   * Valida o JSON do contrato e devolve uma estrutura interna com números de
   * dia. Chaves desconhecidas são ignoradas (nunca exibidas).
   */
  function normalizeData(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('O arquivo da agenda está em um formato inválido.');
    }
    if (raw.version !== 1) {
      throw new Error('A versão do arquivo da agenda não é suportada por esta página.');
    }
    var rangeStart = parseDay(raw.rangeStart);
    var rangeEnd = parseDay(raw.rangeEnd);
    if (isNaN(rangeStart) || isNaN(rangeEnd) || rangeEnd < rangeStart) {
      throw new Error('O período publicado no arquivo da agenda é inválido.');
    }

    var wh = raw.workHours && typeof raw.workHours === 'object' ? raw.workHours : {};
    var whStart = toMinute(wh.start);
    var whEnd = toMinute(wh.end);
    // Expediente nunca começa antes das 09:00, mesmo que o arquivo diga outra coisa.
    if (whStart !== null) whStart = Math.max(whStart, DAY_START);
    if (whEnd !== null) whEnd = Math.min(whEnd, DAY_END);
    if (whStart === null || whEnd === null || whEnd <= whStart) {
      whStart = DEFAULT_WORK_HOURS.start;
      whEnd = DEFAULT_WORK_HOURS.end;
    }
    var weekdays = [];
    if (Array.isArray(wh.weekdays)) {
      wh.weekdays.forEach(function (v) {
        if (isIsoWeekdayValue(v) && weekdays.indexOf(v) < 0) weekdays.push(v);
      });
      weekdays.sort(function (a, b) { return a - b; });
    }
    if (!weekdays.length) weekdays = DEFAULT_WORK_HOURS.weekdays.slice();

    var busyByDay = {};
    if (raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) {
      Object.keys(raw.days).forEach(function (key) {
        var n = parseDay(key);
        if (isNaN(n)) return;
        var merged = mergeIntervals(raw.days[key]);
        if (merged.length) busyByDay[n] = merged;
      });
    }

    var fullDay = {};
    if (Array.isArray(raw.fullDayBusy)) {
      raw.fullDayBusy.forEach(function (key) {
        var n = parseDay(key);
        if (!isNaN(n)) fullDay[n] = true;
      });
    }

    // Arquivo antigo, sem tags/highlights: tudo continua igual, só sem destaque.
    var tags = normalizeTags(raw.tags);
    var known = Object.create(null);
    tags.forEach(function (tg) { known[tg.key] = true; });

    var generatedAt = typeof raw.generatedAt === 'string' ? raw.generatedAt : '';
    return {
      version: 1,
      generatedAt: generatedAt,
      generatedAtMs: generatedAt ? Date.parse(generatedAt) : NaN,
      timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'America/Sao_Paulo',
      timezoneLabel: typeof raw.timezoneLabel === 'string' && raw.timezoneLabel ? raw.timezoneLabel : 'Horário de Brasília',
      owner: typeof raw.owner === 'string' && raw.owner ? raw.owner : 'Marco',
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      workHours: { start: whStart, end: whEnd, weekdays: weekdays },
      busyByDay: busyByDay,
      fullDay: fullDay,
      tags: tags,
      highlightsByDay: normalizeHighlights(raw.highlights, known)
    };
  }

  // -------------------------------------------------------------- destaques

  /*
   * tags: [{ key, label }], na ordem do app. A chave vira classe CSS
   * (destaque-<key>) e data-tag, então só passa [a-z0-9] com hífens no meio.
   * highlights: { 'yyyy-MM-dd': [{ s, e, t, tag }] }, minutos de relógio de
   * parede como em days. O app tira esses eventos de days (senão sairiam
   * duas vezes); o que vier malformado é ignorado, sem derrubar a página.
   */
  var TAG_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  var TAG_KEY_MAX = 32;
  var TAG_LABEL_MAX = 40;
  var TITLE_MAX = 200;

  /** Texto de uma linha: sem caracteres de controle, espaços colapsados, limitado a max. */
  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    var s = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length > max) {
      var cut = max;
      // Não parte um emoji (par substituto) ao meio.
      var code = s.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
      s = s.slice(0, cut).trim();
    }
    return s;
  }

  function normalizeTags(value) {
    var out = [];
    if (!Array.isArray(value)) return out;
    var seen = Object.create(null);
    value.forEach(function (tg) {
      if (!tg || typeof tg !== 'object' || Array.isArray(tg)) return;
      var key = tg.key;
      if (typeof key !== 'string' || key.length > TAG_KEY_MAX || !TAG_KEY_RE.test(key) || seen[key]) return;
      var label = cleanText(tg.label, TAG_LABEL_MAX);
      if (!label) return;
      seen[key] = true;
      out.push({ key: key, label: label });
    });
    return out;
  }

  function compareText(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  function compareHighlights(a, b) {
    return a.s - b.s || a.e - b.e || compareText(a.t, b.t) || compareText(a.tag, b.tag);
  }

  /** Dia -> destaques válidos, ordenados por início, fim e título, sem repetição. */
  function normalizeHighlights(value, known) {
    var out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    Object.keys(value).forEach(function (key) {
      var n = parseDay(key);
      var list = value[key];
      if (isNaN(n) || !Array.isArray(list)) return;
      list.forEach(function (h) {
        if (!h || typeof h !== 'object' || Array.isArray(h)) return;
        if (typeof h.s !== 'number' || typeof h.e !== 'number' || !isFinite(h.s) || !isFinite(h.e)) return;
        var s = Math.round(h.s), e = Math.round(h.e);
        if (s < 0 || e > MINUTES_IN_DAY || e <= s) return;
        if (typeof h.tag !== 'string' || known[h.tag] !== true) return;
        var t = cleanText(h.t, TITLE_MAX);
        if (!t) return;
        (out[n] || (out[n] = [])).push({ s: s, e: e, t: t, tag: h.tag });
      });
    });
    Object.keys(out).forEach(function (n) {
      var uniq = [];
      out[n].sort(compareHighlights).forEach(function (h) {
        if (!uniq.length || compareHighlights(uniq[uniq.length - 1], h) !== 0) uniq.push(h);
      });
      out[n] = uniq;
    });
    return out;
  }

  /** Nome da etiqueta ('NASA'). Chave desconhecida devolve a própria chave. */
  function tagLabel(data, key) {
    var tags = data.tags || [];
    for (var i = 0; i < tags.length; i++) if (tags[i].key === key) return tags[i].label;
    return key;
  }

  /** Destaques do dia (cópias), na ordem do arquivo normalizado. */
  function highlightsForDay(data, n) {
    var list = data.highlightsByDay && data.highlightsByDay[n];
    return list ? list.map(function (h) { return { s: h.s, e: h.e, t: h.t, tag: h.tag }; }) : [];
  }

  /**
   * Destaques que a página desenha: os que tocam a janela 09:00-20:00, como o
   * ocupado. vs/ve = pedaço desenhado (recortado na janela); s/e continuam o
   * horário real da reunião, que é o que o texto mostra.
   */
  function visibleHighlightsForDay(data, n) {
    var out = [];
    highlightsForDay(data, n).forEach(function (h) {
      var vs = Math.max(h.s, DAY_START), ve = Math.min(h.e, DAY_END);
      if (ve <= vs) return;
      h.vs = vs;
      h.ve = ve;
      out.push(h);
    });
    return out;
  }

  /**
   * Todo o tempo tomado no dia: o ocupado anônimo MAIS os destaques (o app os
   * tira de days). É disso que sai o "Livre" do celular, senão a reunião em
   * destaque viraria horário livre.
   */
  function occupiedForDay(data, n) {
    return mergeIntervals(busyForDay(data, n).concat(highlightsForDay(data, n).map(function (h) {
      return [h.s, h.e];
    })));
  }

  /**
   * Dica do mouse e texto do leitor de tela de uma reunião em destaque: só o
   * título e o horário real, 'CEAP + NASA Space Apps, 14:30 a 15:00' (sem
   * "Reunião com ...", pedido do Marco).
   */
  function describeHighlight(h) {
    return h.t + ', ' + formatRange(h.s, h.e);
  }

  /**
   * Dias do filtro da etiqueta: de fromDay (hoje) até rangeEnd, dentro do
   * período, com pelo menos um destaque dela VISÍVEL (que toca 09:00-20:00;
   * um dia só com reunião fora da janela abriria vazio). Em ordem crescente.
   * Dia que já passou nunca entra (só de hoje em diante); hoje entra mesmo
   * que a call de hoje já tenha acabado.
   */
  function tagFilterDays(data, key, fromDay) {
    var from = Math.max(toDayNumber(fromDay), data.rangeStart);
    var out = [];
    if (isNaN(from)) return out;
    Object.keys(data.highlightsByDay || {}).forEach(function (k) {
      var n = Number(k);
      if (!(n >= from && n <= data.rangeEnd)) return;
      if (visibleHighlightsForDay(data, n).some(function (h) { return h.tag === key; })) out.push(n);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  /** Páginas de VIEW_DAYS (6) dias do filtro. */
  function filterPageCount(days) { return Math.ceil(days.length / VIEW_DAYS); }

  function filterPage(days, page) {
    var p = clamp(page, 0, Math.max(0, filterPageCount(days) - 1));
    return days.slice(p * VIEW_DAYS, p * VIEW_DAYS + VIEW_DAYS);
  }

  /** Primeira página com um dia >= n; depois do último dia, a última página. */
  function filterPageForDay(days, n) {
    for (var i = 0; i < days.length; i++) {
      if (days[i] >= n) return Math.floor(i / VIEW_DAYS);
    }
    return Math.max(0, filterPageCount(days) - 1);
  }

  /**
   * Textos do filtro, montados com o nome da etiqueta (data.tags[].label), para
   * outro nome também ficar bom: "Calls da NASA agendadas", "Calls da Ana
   * agendadas". anterior/proxima/ir = nomes acessíveis de ‹, › e do campo de
   * data com o filtro ligado; vazio = nenhum dia; botao = dica do botão da
   * etiqueta desligado.
   */
  function filterTexts(label) {
    return {
      anterior: 'Calls anteriores da ' + label,
      proxima: 'Próximas calls da ' + label,
      ir: 'Ir para a próxima call da ' + label + ' a partir desta data',
      vazio: 'Nenhuma call da ' + label + ' agendada de hoje em diante.',
      botao: 'Mostrar só as calls da ' + label + ' agendadas, de hoje em diante'
    };
  }

  /**
   * Título com o filtro ligado: 'Calls da NASA agendadas: 19/10 a 21/10'
   * (primeiro e último dia da página); um dia só: 'Calls da NASA agendadas:
   * 21/10'; nenhum: o texto de vazio.
   */
  function formatFilterTitle(label, days) {
    if (!days.length) return filterTexts(label).vazio;
    var a = formatDDMM(days[0]), b = formatDDMM(days[days.length - 1]);
    return 'Calls da ' + label + ' agendadas: ' + (a === b ? a : a + ' a ' + b);
  }

  function isInRange(data, n) { return n >= data.rangeStart && n <= data.rangeEnd; }
  function isFullDay(data, n) { return data.fullDay[n] === true; }
  function isWorkday(data, n) { return data.workHours.weekdays.indexOf(isoWeekday(n)) >= 0; }

  /** Intervalos ocupados do dia. Dia inteiro bloqueado = [[0,1440]]. */
  function busyForDay(data, n) {
    if (isFullDay(data, n)) return [[0, MINUTES_IN_DAY]];
    var list = data.busyByDay[n];
    return list ? list.map(function (iv) { return [iv[0], iv[1]]; }) : [];
  }

  /**
   * O ocupado que a página desenha: só entre 09:00 e 20:00. Bloco que passa da
   * janela é cortado nela; bloco todo fora dela some.
   */
  function visibleBusyForDay(data, n) {
    var out = [];
    busyForDay(data, n).forEach(function (iv) {
      // Recorta na janela 09:00-20:00; o que fica todo fora dela não aparece.
      var s = Math.max(iv[0], DAY_START), e = Math.min(iv[1], DAY_END);
      if (e > s) out.push([s, e]);
    });
    return out;
  }

  /**
   * Blocos lado a lado. Reunião em destaque sobre um ocupado anônimo, ou duas
   * reuniões no mesmo horário, dividem a largura da coluna em pistas para
   * nenhuma cobrir a outra (título e horário sempre à vista). Recebe
   * [início, fim] já recortados na janela e devolve, na mesma ordem,
   * { lane, lanes }: a pista do bloco (0 = a da esquerda) e quantas pistas tem o
   * grupo dele. Grupo = blocos ligados por sobreposição, mesmo indireta; cada
   * bloco entra na primeira pista já livre no início dele (o mais cedo antes; no
   * empate, o mais longo, depois a ordem de entrada). Encostar (fim = início)
   * não é sobrepor.
   */
  function laneLayout(list) {
    var out = [];
    var order = [];
    for (var i = 0; i < list.length; i++) order.push(i);
    order.sort(function (a, b) { return list[a][0] - list[b][0] || list[b][1] - list[a][1] || a - b; });
    var group = [], laneEnds = [], groupEnd = 0;
    function closeGroup() {
      group.forEach(function (k) { out[k].lanes = laneEnds.length; });
      group = [];
      laneEnds = [];
    }
    order.forEach(function (k) {
      var s = list[k][0], e = list[k][1];
      if (group.length && s >= groupEnd) closeGroup();
      groupEnd = group.length ? Math.max(groupEnd, e) : e;
      var lane = 0;
      while (lane < laneEnds.length && laneEnds[lane] > s) lane++;
      laneEnds[lane] = e;
      out[k] = { lane: lane, lanes: 1 };
      group.push(k);
    });
    if (group.length) closeGroup();
    return out;
  }

  function clampDay(data, n) { return clamp(n, data.rangeStart, data.rangeEnd); }

  /** Último dia mostrado numa tela que começa em start. */
  function lastViewDay(start) {
    var days = viewDays(start);
    return days[days.length - 1];
  }

  /**
   * Limites do primeiro dia da tabela. first: o início mais cedo cuja tela
   * ainda mostra algum dia publicado (o último dos 6 dias >= rangeStart). A
   * tabela começa em qualquer dia da semana, então ‹ e ← voltam 7 dias exatos
   * e só desligam quando a tela anterior não teria nenhum dia publicado: com
   * rangeStart numa terça 13/10, de 14/10 volta para 07/10 (07 a 13), e de
   * 13/10 não volta (06 a 12 não tem nada). Nada de alinhar na segunda, que
   * repetia dias ao voltar até o começo. last: rangeEnd (uma data escolhida
   * perto do fim ainda abre nela).
   */
  function weekBounds(data) {
    var first = data.rangeStart - 7;
    while (isoWeekday(first) === 7 || lastViewDay(first) < data.rangeStart) first++;
    return { first: first, last: data.rangeEnd };
  }

  /**
   * Primeiro dia da tabela ao abrir a página, no "Hoje" e na virada do dia: o
   * próprio dia de hoje (terça 13/10 mostra 13, 14, 15, 16, 17 e 19), limitado
   * ao período. Domingo começa na segunda seguinte (clampStart).
   */
  function defaultStart(data, today) {
    return clampStart(data, clampDay(data, toDayNumber(today)));
  }

  /**
   * Dia inicial da tabela, SEM alinhar na segunda: as setas andam 7 dias a
   * partir dele e uma data escolhida (já limitada ao período, clampDay) vira o
   * primeiro dia mostrado. Limitado a weekBounds.
   */
  function clampStart(data, n) {
    var b = weekBounds(data);
    var c = clamp(n, b.first, b.last);
    if (isoWeekday(c) !== 7) return c;
    // Domingo nunca é o primeiro dia: começa na segunda seguinte. Se essa segunda
    // já passou do fim do período (o período terminou num domingo), mostra a
    // segunda a sábado anterior, que ainda está publicada.
    return c + 1 <= b.last ? c + 1 : c - 6;
  }

  // ---------------------------------------------------------------- "agora"

  var zoneFormatters = {};

  function zoneFormatter(timeZone) {
    if (!zoneFormatters[timeZone]) {
      zoneFormatters[timeZone] = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      });
    }
    return zoneFormatters[timeZone];
  }

  /** Dia (número) e minuto do dia de um instante, no fuso pedido. */
  function nowInZone(date, timeZone) {
    var d = date instanceof Date ? date : new Date();
    try {
      var parts = {};
      zoneFormatter(timeZone).formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
      var hour = parseInt(parts.hour, 10) % 24;
      var minute = parseInt(parts.minute, 10);
      var day = parseDay(parts.year + '-' + parts.month + '-' + parts.day);
      if (isNaN(day) || isNaN(hour) || isNaN(minute)) throw new Error('partes inválidas');
      return { day: day, minutes: hour * 60 + minute };
    } catch (e) {
      // Fuso desconhecido pelo navegador: usa o relógio local como aproximação.
      return {
        day: Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS),
        minutes: d.getHours() * 60 + d.getMinutes()
      };
    }
  }

  function normalizeNow(now) {
    if (!now) return null;
    var day = toDayNumber(now.day);
    var minutes = Number(now.minutes);
    if (isNaN(day) || !isFinite(minutes)) return null;
    return { day: day, minutes: minutes };
  }

  function nextQuarter(minutes) {
    return Math.floor(minutes / NOW_STEP) * NOW_STEP + NOW_STEP;
  }

  /** Primeiro minuto utilizável do dia: dia passado = nenhum; hoje = próximo quarto de hora. */
  function earliestStartForDay(n, now, base) {
    if (!now) return base;
    if (n < now.day) return MINUTES_IN_DAY;
    if (n === now.day) return Math.max(base, nextQuarter(now.minutes));
    return base;
  }

  // ------------------------------------------------------------- semana

  /**
   * Intervalos livres do dia dentro do horário comercial (para a lista do
   * celular). Começam no workHours.start, que normalizeData já limita a 09:00.
   * Reunião em destaque (fora de days) também ocupa: nunca vira "Livre".
   */
  function freeRangesForDay(data, n, now) {
    if (!isInRange(data, n) || isFullDay(data, n) || !isWorkday(data, n)) return [];
    var ws = earliestStartForDay(n, normalizeNow(now), data.workHours.start);
    var we = data.workHours.end;
    if (ws >= we) return [];
    return complement(occupiedForDay(data, n), ws, we).filter(function (iv) {
      return iv[1] - iv[0] >= MIN_FREE_LISTED;
    });
  }

  /** Janela fixa da grade: 09:00 às 20:00, nunca estende. */
  function gridBounds() {
    return { start: DAY_START, end: DAY_END };
  }

  // ----------------------------------------------------------- formatação

  function formatTime(minutes) {
    var m = Math.round(minutes);
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  function formatRange(s, e) { return formatTime(s) + ' a ' + formatTime(e); }

  // ------------------------------------------------------ tamanho dos blocos

  /*
   * Medidas do agenda.css, em px: linha do texto do bloco (0.75rem x 1.2) e
   * linha do texto pequeno (0.625rem x 1). Bloco lado a lado: o horário
   * compacto pode quebrar depois do hífen ("15:30-" / "16:00") numa pista
   * estreita (768px), então conta sempre DUAS linhas pequenas para ele.
   */
  var LINE_PX = 14.4;
  var SMALL_LINE_PX = 10;
  var LANE_TIME_PX = 2 * SMALL_LINE_PX;
  // Bloco lado a lado alto: bordas (1 + 1) e respiro (1 + 1) em cima e embaixo.
  var LANE_CHROME_PX = 4;
  // A partir daqui (48 minutos) cabem uma linha do título e o horário em duas linhas.
  var LANE_TALL_PX = LANE_CHROME_PX + LANE_TIME_PX + LINE_PX;

  /**
   * Tamanho do bloco pela altura (px) e por dividir a largura (side, pistas).
   * Sozinho na coluna: até uns 20 minutos ' curto', até uns 40 ' medio' (os
   * dois numa linha só: rótulo à esquerda, horário pequeno à direita), acima
   * disso duas linhas (''). Lado a lado: ' curto' igual; ' medio' até uns 47
   * minutos, com o horário pequeno numa linha própria e o título em cima só se
   * couber inteiro (CSS); acima disso alto (''), com o título em quantas linhas
   * couberem (titleLines) e o horário embaixo. Assim um bloco de 42 minutos
   * ou mais mostra título e horário em duas pistas a 768, 1024 e 1280px, e o
   * de 30 minutos mostra ao menos o horário inteiro.
   */
  function blockSize(height, side) {
    if (height < 18) return ' curto';
    // Lado a lado, o médio precisa de 2 linhas pequenas (20px) + bordas: abaixo
    // de 22px (uns 27 min) a 2ª linha do horário era cortada. Fica curto (início).
    if (side && height < LANE_TIME_PX + 2) return ' curto';
    if (!side) return height < 34 ? ' medio' : '';
    return height < LANE_TALL_PX ? ' medio' : '';
  }

  /**
   * Linhas do título num bloco alto: o que sobra da altura (menos bordas e
   * respiro) depois do horário. Sozinho: o horário toma uma linha do bloco;
   * lado a lado: duas linhas pequenas.
   */
  function titleLines(height, side) {
    // + 1e-9: 38.4px - 24 dá 14.399999999999999, que não pode virar 0 linha.
    if (!side) return Math.floor((height - 8) / LINE_PX + 1e-9) - 1;
    return Math.floor((height - LANE_CHROME_PX - LANE_TIME_PX) / LINE_PX + 1e-9);
  }

  /*
   * Reunião em destaque SOZINHA na coluna (não lado a lado), medidas do
   * agenda.css em px. Bloco '' (uns 59 a 63 minutos): título em até 2 linhas
   * de 0.72rem x 1.12 e o horário (0.68rem x 1.2) numa linha embaixo, com
   * bordas (1 + 1) e respiro (3 + 3). Médio em coluna: título (0.68rem x 1.05)
   * e horário (0.58rem x 1), com bordas (1 + 1) e sem respiro.
   */
  var HL_TITLE_LINE_PX = 0.72 * 16 * 1.12;
  var HL_TIME_LINE_PX = 0.68 * 16 * 1.2;
  var HL_CHROME_PX = 8;
  var HL_COLUMN_PX = 2 + 0.68 * 16 * 1.05 + 0.58 * 16;

  /**
   * Formato da reunião em destaque pela altura (px) e por dividir a largura
   * (side): { size, lines }, size = a classe do bloco e lines = linhas do
   * título no alto (--linhas). O HORÁRIO SEMPRE APARECE (pedido do Marco em
   * 15/10/2026, depois de uma call de 45 minutos sair sem o horário):
   * - lado a lado: como sempre (blockSize; alto com titleLines);
   * - sozinha, ' medio' em coluna (título em cima, horário embaixo) só quando
   *   as duas linhas cabem inteiras (29 minutos ou mais); abaixo disso
   *   ' medio linha', numa linha só: título com "…" à esquerda e o horário
   *   à direita, como o ocupado;
   * - sozinha, '' (título em 2 linhas e o horário numa linha embaixo) só
   *   quando as três linhas cabem (59 minutos ou mais); abaixo disso
   *   ' justo': título em até 2 linhas e o horário no canto direito da 2ª,
   *   com o "…" do título antes dele.
   */
  function highlightLayout(height, side) {
    var size = blockSize(height, side);
    if (size === ' medio' && !side && height < HL_COLUMN_PX) return { size: ' medio linha', lines: 1 };
    if (size) return { size: size, lines: 1 };
    var lines = titleLines(height, side);
    if (lines >= 2) return { size: ' alto', lines: lines };
    if (!side && height - HL_CHROME_PX < 2 * HL_TITLE_LINE_PX + HL_TIME_LINE_PX) return { size: ' justo', lines: 2 };
    return { size: '', lines: lines };
  }

  function formatDDMM(n) {
    var p = dayParts(n);
    return pad2(p.d) + '/' + pad2(p.m);
  }

  /** 'qua, 14/10' */
  function formatDayShort(n) {
    return WEEKDAYS_SHORT[isoWeekday(n) - 1] + ', ' + formatDDMM(n);
  }

  /** 'quarta-feira, 14/10' */
  function formatDayLong(n) {
    return WEEKDAYS_LONG[isoWeekday(n) - 1] + ', ' + formatDDMM(n);
  }

  function dayOrdinal(d) { return d === 1 ? '1º' : String(d); }

  /**
   * Primeiro e último dia mostrados (viewDays): '12 a 17 de outubro de 2026',
   * '13 a 19 de outubro de 2026', '28 de outubro a 3 de novembro de 2026'.
   */
  function formatWeekLabel(start) {
    var days = viewDays(start);
    var a = dayParts(days[0]), b = dayParts(days[days.length - 1]);
    if (a.y === b.y && a.m === b.m) {
      return dayOrdinal(a.d) + ' a ' + b.d + ' de ' + MONTHS[a.m - 1] + ' de ' + a.y;
    }
    if (a.y === b.y) {
      return dayOrdinal(a.d) + ' de ' + MONTHS[a.m - 1] + ' a ' + dayOrdinal(b.d) + ' de ' +
        MONTHS[b.m - 1] + ' de ' + a.y;
    }
    return dayOrdinal(a.d) + ' de ' + MONTHS[a.m - 1] + ' de ' + a.y + ' a ' + dayOrdinal(b.d) +
      ' de ' + MONTHS[b.m - 1] + ' de ' + b.y;
  }

  /** 'Atualizada em 13/10 às 19:30', no fuso da agenda. null se a data for inválida. */
  function formatGeneratedAt(iso, timeZone) {
    var ms = Date.parse(iso);
    if (isNaN(ms)) return null;
    var z = nowInZone(new Date(ms), timeZone);
    return 'Atualizada em ' + formatDDMM(z.day) + ' às ' + formatTime(z.minutes);
  }

  function isStale(generatedAtMs, nowMs) {
    if (isNaN(generatedAtMs)) return false;
    return nowMs - generatedAtMs > STALE_MS;
  }

  // ------------------------------------------------------------------ cifra

  /*
   * dados/ocupado.enc.json, escrito pelo app:
   *   {"v":1,"alg":"AES-256-GCM","kdf":"PBKDF2-SHA256","iter":250000,
   *    "salt":"<base64, 16 bytes>","iv":"<base64, 12 bytes>",
   *    "data":"<base64 do texto cifrado seguido da tag GCM de 16 bytes>"}
   * chave = PBKDF2-HMAC-SHA256(senha em UTF-8, salt, iter, 32 bytes). O texto
   * aberto é o JSON de sempre (normalizeData). O WebCrypto espera a tag colada
   * no fim do texto cifrado, que é exatamente o formato de "data".
   */
  var ENC_VERSION = 1;
  var ENC_ALG = 'AES-256-GCM';
  var ENC_KDF = 'PBKDF2-SHA256';
  // Fora disso o arquivo é recusado: pouco demais seria fraco, muito trava o celular.
  var ITER_MIN = 100000;
  var ITER_MAX = 2000000;
  var SALT_BYTES = 16;
  var IV_BYTES = 12;
  var TAG_BYTES = 16;

  var MSG_SENHA = 'Senha incorreta.';
  var MSG_FORMATO = 'O arquivo da agenda está em um formato que esta página não reconhece. Tente recarregar a página mais tarde.';
  var MSG_CORROMPIDO = 'O arquivo da agenda está corrompido ou incompleto.';
  var MSG_NAVEGADOR = 'Este navegador não consegue abrir a agenda protegida. Abra a página pelo endereço https, ' +
    'em uma versão atual do Chrome, Safari, Firefox ou Edge.';

  /** Erro com code: 'senha' (senha errada ou arquivo adulterado), 'formato' ou 'navegador'. */
  function cryptoError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /** Base64 padrão -> Uint8Array. null se não for base64 válido. */
  function base64ToBytes(value) {
    if (typeof value !== 'string') return null;
    var s = value.replace(/\s+/g, '');
    if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+\/]+={0,2}$/.test(s)) return null;
    var bin;
    try {
      if (typeof global.atob === 'function') bin = global.atob(s);
      else if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
      else return null;
    } catch (e) {
      return null;
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Confere o envelope cifrado e devolve os bytes. Lança cryptoError('formato'). */
  function parseEnvelope(enc) {
    if (!enc || typeof enc !== 'object' || Array.isArray(enc)) throw cryptoError('formato', MSG_CORROMPIDO);
    if (enc.v !== ENC_VERSION || enc.alg !== ENC_ALG || enc.kdf !== ENC_KDF) throw cryptoError('formato', MSG_FORMATO);
    var iter = enc.iter;
    if (typeof iter !== 'number' || !isFinite(iter) || Math.floor(iter) !== iter || iter < ITER_MIN || iter > ITER_MAX) {
      throw cryptoError('formato', MSG_FORMATO);
    }
    var salt = base64ToBytes(enc.salt), iv = base64ToBytes(enc.iv), data = base64ToBytes(enc.data);
    if (!salt || salt.length !== SALT_BYTES || !iv || iv.length !== IV_BYTES || !data || data.length <= TAG_BYTES) {
      throw cryptoError('formato', MSG_CORROMPIDO);
    }
    return { iter: iter, salt: salt, iv: iv, data: data };
  }

  /** crypto.subtle do navegador ou do Node (18 com flag: cai no require('crypto').webcrypto). */
  function getSubtle() {
    var c = global.crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (c && c.subtle) return c.subtle;
    if (typeof require === 'function') {
      try {
        var nodeCrypto = require('crypto');
        if (nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) return nodeCrypto.webcrypto.subtle;
      } catch (e) { /* sem Node */ }
    }
    return null;
  }

  /**
   * Decifra o envelope com a senha (exatamente como digitada, em UTF-8) e
   * devolve o objeto do contrato, ainda sem normalizeData. Promise; falha com
   * cryptoError: 'senha' quando a senha não confere ou o arquivo foi alterado
   * (o GCM não distingue os dois), 'formato', 'navegador'.
   */
  function decryptPayload(encObj, password) {
    return new Promise(function (resolve) {
      var env = parseEnvelope(encObj);
      if (typeof password !== 'string' || !password) throw cryptoError('senha', MSG_SENHA);
      var subtle = getSubtle();
      var Enc = global.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
      var Dec = global.TextDecoder || (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
      if (!subtle || !Enc || !Dec) throw cryptoError('navegador', MSG_NAVEGADOR);
      resolve({ env: env, subtle: subtle, pw: new Enc().encode(password), Dec: Dec });
    }).then(function (ctx) {
      return Promise.resolve()
        .then(function () { return ctx.subtle.importKey('raw', ctx.pw, 'PBKDF2', false, ['deriveKey']); })
        .then(function (base) {
          return ctx.subtle.deriveKey(
            { name: 'PBKDF2', salt: ctx.env.salt, iterations: ctx.env.iter, hash: 'SHA-256' },
            base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        })
        .then(null, function () { throw cryptoError('navegador', MSG_NAVEGADOR); })
        .then(function (key) {
          return ctx.subtle.decrypt({ name: 'AES-GCM', iv: ctx.env.iv, tagLength: TAG_BYTES * 8 }, key, ctx.env.data)
            .then(null, function () { throw cryptoError('senha', MSG_SENHA); });
        })
        .then(function (plain) {
          var text;
          try { text = new ctx.Dec('utf-8', { fatal: true }).decode(plain); } catch (e) { throw cryptoError('formato', MSG_CORROMPIDO); }
          try { return JSON.parse(text); } catch (e2) { throw cryptoError('formato', MSG_CORROMPIDO); }
        });
    });
  }

  /**
   * Senhas a tentar, nesta ordem: a digitada e, se for diferente, a mesma sem
   * espaços nas pontas e em Unicode NFC (colar do WhatsApp traz espaço ou quebra
   * de linha; acento pode vir decomposto). No máximo duas derivações.
   */
  function passwordCandidates(typed) {
    var out = [];
    if (typeof typed !== 'string' || !typed) return out;
    out.push(typed);
    var alt = typed.trim();
    if (typeof alt.normalize === 'function') alt = alt.normalize('NFC');
    if (alt && alt !== typed) out.push(alt);
    return out;
  }

  var AgendaCore = {
    MINUTES_IN_DAY: MINUTES_IN_DAY,
    DAY_START: DAY_START,
    DAY_END: DAY_END,
    parseDay: parseDay,
    formatDay: formatDay,
    dayParts: dayParts,
    isoWeekday: isoWeekday,
    viewDays: viewDays,
    mondayOf: mondayOf,
    weekBreaks: weekBreaks,
    VIEW_DAYS: VIEW_DAYS,
    clamp: clamp,
    mergeIntervals: mergeIntervals,
    complement: complement,
    normalizeData: normalizeData,
    isInRange: isInRange,
    isFullDay: isFullDay,
    isWorkday: isWorkday,
    busyForDay: busyForDay,
    visibleBusyForDay: visibleBusyForDay,
    clampDay: clampDay,
    weekBounds: weekBounds,
    defaultStart: defaultStart,
    clampStart: clampStart,
    laneLayout: laneLayout,
    nowInZone: nowInZone,
    nextQuarter: nextQuarter,
    freeRangesForDay: freeRangesForDay,
    gridBounds: gridBounds,
    formatTime: formatTime,
    formatRange: formatRange,
    blockSize: blockSize,
    highlightLayout: highlightLayout,
    titleLines: titleLines,
    formatDDMM: formatDDMM,
    formatDayShort: formatDayShort,
    formatDayLong: formatDayLong,
    formatWeekLabel: formatWeekLabel,
    formatGeneratedAt: formatGeneratedAt,
    isStale: isStale,
    normalizeTags: normalizeTags,
    normalizeHighlights: normalizeHighlights,
    tagLabel: tagLabel,
    highlightsForDay: highlightsForDay,
    visibleHighlightsForDay: visibleHighlightsForDay,
    occupiedForDay: occupiedForDay,
    describeHighlight: describeHighlight,
    tagFilterDays: tagFilterDays,
    filterPageCount: filterPageCount,
    filterPage: filterPage,
    filterPageForDay: filterPageForDay,
    filterTexts: filterTexts,
    formatFilterTitle: formatFilterTitle,
    ITER_MIN: ITER_MIN,
    ITER_MAX: ITER_MAX,
    base64ToBytes: base64ToBytes,
    parseEnvelope: parseEnvelope,
    decryptPayload: decryptPayload,
    passwordCandidates: passwordCandidates
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AgendaCore;
  if (typeof window !== 'undefined') window.AgendaCore = AgendaCore;

  if (typeof document === 'undefined') return;

  // =================================================================== UI

  var C = AgendaCore;
  var HOUR_PX = 48;
  // Fuso do esqueleto (antes de decifrar ainda não se sabe o do arquivo): o padrão da agenda.
  var DEFAULT_ZONE = 'America/Sao_Paulo';
  // Nome acessível do campo de data sem filtro (o mesmo do index.html).
  var IR_LABEL = 'Começar a tabela nesta data';

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style') Object.keys(v).forEach(function (s) { node.style.setProperty(s, v[s]); });
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function sameKind(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    return a.nodeType !== 1 || a.tagName === b.tagName;
  }

  /**
   * Deixa `cur` igual a `next` mexendo só no que mudou. Os nós que não mudaram
   * continuam os mesmos: o leitor de tela não perde a posição quando a agenda
   * é redesenhada a cada minuto.
   */
  function morph(cur, next) {
    var i, name, attr;
    if (cur.nodeType !== 1) {
      if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue;
      return;
    }
    for (i = cur.attributes.length - 1; i >= 0; i--) {
      name = cur.attributes[i].name;
      if (!next.hasAttribute(name)) cur.removeAttribute(name);
    }
    for (i = 0; i < next.attributes.length; i++) {
      attr = next.attributes[i];
      if (cur.getAttribute(attr.name) !== attr.value) cur.setAttribute(attr.name, attr.value);
    }
    var kids = Array.prototype.slice.call(next.childNodes);
    for (i = 0; i < kids.length; i++) {
      var have = cur.childNodes[i] || null;
      if (!have) cur.appendChild(kids[i]);
      else if (sameKind(have, kids[i])) morph(have, kids[i]);
      else cur.replaceChild(kids[i], have);
    }
    while (cur.childNodes.length > kids.length) cur.removeChild(cur.lastChild);
  }

  function start() {
    var $ = function (id) { return document.getElementById(id); };
    var els = {
      portao: $('portao'), portaoFalha: $('portao-falha'), formSenha: $('form-senha'), senha: $('f-senha'),
      mostrar: $('btn-mostrar'), entrar: $('btn-entrar'), senhaErro: $('senha-erro'),
      app: $('app'), sair: $('btn-sair'), recarregar: $('btn-recarregar'),
      titulo: $('titulo'), fuso: $('fuso'), atualizada: $('atualizada'), aviso: $('aviso-antigo'),
      anterior: $('btn-anterior'), hoje: $('btn-hoje'), proxima: $('btn-proxima'), ir: $('f-ir'),
      semanaTitulo: $('semana-titulo'), semana: $('semana')
    };
    // week: primeiro dia mostrado (sem filtro). filter: null ou
    // { tag, page, all, picked } quando um botão de etiqueta (NASA) está
    // ligado; state.week fica intacto enquanto isso, e desligar o filtro volta
    // para a tela de antes. picked = data digitada com o filtro ligado.
    // shown = dias da última tela desenhada. loading = esqueleto na tela
    // (senha salva, chave ainda sendo derivada).
    var state = { data: null, now: null, week: null, wide: false, filter: null, shown: [], loading: false };
    var mq = window.matchMedia ? window.matchMedia('(min-width: 768px)') : null;
    // campo de data em edição, pelos eventos focus/blur do próprio campo. Não
    // dá para usar document.activeElement: no Chromium, no 'change' do dígito
    // que fecha um segmento (dia -> mês), o foco está trocando de segmento por
    // dentro e activeElement não é o campo, sem blur nenhum.
    var editingIr = false;

    function today() { return state.now.day; }

    function updateHeader() {
      var d = state.data;
      // Só o primeiro nome no título ("Agenda do Marco").
      var name = 'Agenda do ' + (String(d.owner).trim().split(/\s+/)[0] || 'Marco');
      els.titulo.textContent = name;
      document.title = name;
      els.fuso.textContent = d.timezoneLabel;
      els.atualizada.textContent = C.formatGeneratedAt(d.generatedAt, d.timezone) || 'Data de atualização indisponível';
      els.aviso.hidden = !C.isStale(d.generatedAtMs, Date.now());
      renderTagButtons(d.tags);
    }

    // ------------------------------------------------- etiquetas (filtro)

    function tagButtons() {
      return Array.prototype.slice.call(els.fuso.parentNode.querySelectorAll('.tag-filtro'));
    }

    function removeTagButtons() {
      tagButtons().forEach(function (b) { b.parentNode.removeChild(b); });
    }

    /** Um botão por etiqueta do arquivo, logo depois do fuso ("Horário de Brasília"). */
    function renderTagButtons(tags) {
      removeTagButtons();
      var anchor = els.fuso;
      tags.forEach(function (tg) {
        var b = el('button', {
          type: 'button', class: 'tag-filtro', 'data-tag': tg.key, 'aria-pressed': 'false', text: tg.label,
          onclick: function () { toggleTag(tg.key); }
        });
        anchor.parentNode.insertBefore(b, anchor.nextSibling);
        anchor = b;
      });
    }

    /** Liga o filtro da etiqueta; clicar de novo desliga. Só um filtro por vez. */
    function toggleTag(key) {
      if (!state.data) return;
      state.filter = state.filter && state.filter.tag === key ? null : { tag: key, page: 0, all: [], picked: NaN };
      renderCalendar();
    }

    function syncTagButtons() {
      tagButtons().forEach(function (b) {
        var on = !!state.filter && b.getAttribute('data-tag') === state.filter.tag;
        var hint = on ? 'Mostrar todos os dias de novo' : C.filterTexts(b.textContent).botao;
        if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
        if (b.title !== hint) b.title = hint;
      });
    }

    // ------------------------------------------------------------ navegação

    /**
     * "Hoje" (o botão e o Enter): a tabela começa hoje (domingo: na segunda
     * seguinte), dentro do período. Com filtro, volta à primeira página (os
     * dias do filtro começam hoje). A data escolhida no campo deixa de valer.
     */
    function goToday() {
      if (!state.data) return;
      els.ir.value = '';
      if (state.filter) {
        state.filter.page = 0;
        state.filter.picked = NaN;
      } else {
        state.week = C.defaultStart(state.data, today());
      }
      renderCalendar();
    }

    /** Primeiro dia exato da tabela (setas e data escolhida). */
    function setStart(n) {
      if (!state.data) return;
      state.week = C.clampStart(state.data, n);
      renderCalendar();
    }

    /**
     * ‹ › e as setas do teclado: sem filtro andam 7 dias EXATOS (nunca menos:
     * se a tela de 7 dias antes ou depois não teria nenhum dia publicado, não
     * anda, e o botão já está desligado); com filtro, uma página (6 dias com
     * call).
     */
    function step(dir) {
      if (!state.data) return;
      if (state.filter) {
        state.filter.page += dir;
        renderCalendar();
        return;
      }
      var next = state.week + 7 * dir;
      if (next < C.weekBounds(state.data).first || next > state.data.rangeEnd) return;
      setStart(next);
    }

    /** Dias da tela atual. Com filtro, recalcula a lista (hoje anda) e limita a página. */
    function currentDays() {
      var f = state.filter;
      if (!f) return C.viewDays(state.week);
      f.all = C.tagFilterDays(state.data, f.tag, today());
      f.page = C.clamp(f.page, 0, Math.max(0, C.filterPageCount(f.all) - 1));
      return C.filterPage(f.all, f.page);
    }

    function setLabel(node, text) {
      if (node.getAttribute('aria-label') !== text) node.setAttribute('aria-label', text);
    }

    function updateNav() {
      var f = state.filter;
      // Filtro ligado: o campo de data some (a tela já mostra as calls), e as
      // setas só aparecem se as calls não couberem numa tela (mais de 6 dias).
      var irWrap = els.ir.parentElement;
      var umaTela = !!f && C.filterPageCount(f.all) <= 1;
      els.anterior.hidden = umaTela;
      els.proxima.hidden = umaTela;
      if (irWrap) irWrap.hidden = !!f;
      if (f) {
        var texts = C.filterTexts(C.tagLabel(state.data, f.tag));
        els.anterior.disabled = f.page <= 0;
        els.proxima.disabled = f.page >= C.filterPageCount(f.all) - 1;
        setLabel(els.anterior, texts.anterior);
        setLabel(els.proxima, texts.proxima);
        // Com filtro a data não começa a tabela: leva à próxima call a partir dela.
        setLabel(els.ir, texts.ir);
      } else {
        // ‹ desliga só quando a tela de 7 dias antes não teria nenhum dia
        // publicado (começaria antes de weekBounds.first); › quando a de 7
        // dias depois começaria depois de rangeEnd.
        var b = C.weekBounds(state.data);
        els.anterior.disabled = state.week - 7 < b.first;
        els.proxima.disabled = state.week + 7 > state.data.rangeEnd;
        setLabel(els.anterior, '7 dias antes');
        setLabel(els.proxima, '7 dias depois');
        setLabel(els.ir, IR_LABEL);
      }
      syncTagButtons();
      els.hoje.disabled = false;
      if (els.ir.disabled) els.ir.disabled = false;
      // Só grava min/max se mudou: regravar (mesmo igual) zera o dígito que o
      // Chromium guarda no meio da digitação, e o segundo "1" de "11" se perdia.
      var min = C.formatDay(state.data.rangeStart), max = C.formatDay(state.data.rangeEnd);
      if (els.ir.min !== min) els.ir.min = min;
      if (els.ir.max !== max) els.ir.max = max;
      syncIrField(false);
      els.semanaTitulo.textContent = f
        ? C.formatFilterTitle(C.tagLabel(state.data, f.tag), state.shown)
        : 'Semana de ' + C.formatWeekLabel(state.week);
    }

    /**
     * Põe em campo de data um dia da tela mostrada. Com o campo em foco
     * não mexe (force = false): o Chromium dispara 'change' a cada dígito, e
     * reescrever ali apagava a data pela metade. O acerto fica para o blur/Enter.
     * Com filtro, a data que a pessoa escolheu fica no campo só se cair ENTRE o
     * primeiro e o último dia da página na tela (22/10 numa página de 13/10 a
     * 02/11 fica, mesmo sem call em 22/10); antes do primeiro ou depois do
     * último (05/12 leva à última página, que acaba em 15/11), o campo vai
     * para um dia da página.
     */
    function syncIrField(force) {
      if (!force && editingIr) return;
      var typed = C.parseDay(els.ir.value);
      var shown = state.shown, f = state.filter;
      var keep = !isNaN(typed) && C.isInRange(state.data, typed) && (shown.indexOf(typed) >= 0 ||
        (!!f && typed === f.picked && shown.length > 0 && typed >= shown[0] && typed <= shown[shown.length - 1]));
      if (!keep) {
        var pick = !shown.length || shown.indexOf(today()) >= 0 ? today() : shown[0];
        els.ir.value = C.formatDay(C.clampDay(state.data, pick));
      }
    }

    /** Com filtro, a data escolhida leva à primeira página com um dia >= ela. */
    function jumpFilterTo(n) {
      state.filter.picked = n;
      var page = C.filterPageForDay(state.filter.all, n);
      if (page === state.filter.page) return false;
      state.filter.page = page;
      renderCalendar();
      return true;
    }

    /** Blur ou Enter em campo de data: agora sim grava o valor limitado ao período. */
    function commitIr() {
      if (!state.data) return;
      var n = C.parseDay(els.ir.value);
      if (!isNaN(n)) {
        var c = C.clampDay(state.data, n);
        if (els.ir.value !== C.formatDay(c)) els.ir.value = C.formatDay(c);
        if (state.filter) {
          if (jumpFilterTo(c)) return;
        } else if (C.clampStart(state.data, c) !== state.week) {
          setStart(c);
          return;
        }
      }
      syncIrField(true);
    }

    // --------------------------------------------------------- visão semana

    /** Texto do leitor de tela da coluna: ocupado anônimo e, depois, cada reunião em destaque. */
    function busySummary(d, n) {
      var head = C.formatDayLong(n) + ': ';
      if (!C.isInRange(d, n)) return head + 'fora do período publicado.';
      var parts = [];
      if (C.isFullDay(d, n)) {
        parts.push('dia indisponível.');
      } else {
        var busy = C.visibleBusyForDay(d, n);
        if (busy.length) {
          parts.push('ocupado ' + busy.map(function (iv) {
            return 'das ' + C.formatTime(iv[0]) + ' às ' + C.formatTime(iv[1]);
          }).join(', ') + '.');
        }
      }
      C.visibleHighlightsForDay(d, n).forEach(function (h) { parts.push(C.describeHighlight(h) + '.'); });
      return head + (parts.length ? parts.join(' ') : 'nenhum horário ocupado.');
    }

    /** Já aconteceu: no dia anterior, ou hoje com fim <= agora. */
    function isGone(n, end) {
      return n < today() || (n === today() && end <= state.now.minutes);
    }

    /** Altura em px de uma duração em minutos (multiplica antes: 42 min = 33.6px, sem 33.599999...). */
    function durationPx(minutes) { return minutes * HOUR_PX / 60; }

    /** Posição do bloco: altura pelo horário; largura pela pista (lado a lado, laneLayout). */
    function blockStyle(s, e, lane, px) {
      var style = { top: px(s) + 'px', height: durationPx(e - s) + 'px' };
      if (isSide(lane)) {
        style['--pista'] = String(lane.lane);
        style['--pistas'] = String(lane.lanes);
      }
      return style;
    }

    /** Bloco dividindo a largura com outro (' lado'): pista estreita, o CSS aperta o texto. */
    function isSide(lane) { return !!lane && lane.lanes > 1; }

    /**
     * Rótulo (título) e horário do bloco. Lado a lado o horário é o compacto,
     * '15:30-16:00', que numa pista estreita pode quebrar depois do hífen (o
     * <wbr> garante o ponto de quebra; o leitor de tela não lê o bloco). O fim
     * ('-16:00') fica num span .fim: no bloco curto lado a lado (uma linha só)
     * numa pista estreita demais para o horário inteiro, o CSS mostra só o
     * início, '15:30', em vez de cortar no meio. No bloco médio lado a lado o
     * horário vem ANTES no DOM: o CSS (coluna invertida, com quebra) desenha o
     * título em cima e, se o título não couber inteiro, manda ELE para fora do
     * bloco, nunca o horário. Fora das pistas o ' a ' do horário fica num span
     * .sep: na coluna estreita o CSS troca por '-' na reunião em destaque de uma
     * linha ('09:45-10:08'), para sobrar lugar ao título. No ' justo' (destaque sozinho de uns 43 a 58
     * minutos) o horário vai DENTRO do texto, antes do título, para o CSS
     * fazê-lo flutuar no canto direito da 2ª linha (.texto > .fluxo, ver o
     * agenda.css).
     */
    function blockContent(label, s, e, size, side) {
      var rotulo = el('span', { class: 'rotulo', text: label });
      var faixa = side
        ? el('span', { class: 'faixa' }, [C.formatTime(s), el('span', { class: 'fim' }, ['-', el('wbr'), C.formatTime(e)])])
        : el('span', { class: 'faixa' }, [C.formatTime(s), el('span', { class: 'sep', text: ' a ' }), C.formatTime(e)]);
      if (size === ' justo') return [el('span', { class: 'texto' }, [el('span', { class: 'fluxo' }, [faixa, rotulo])])];
      return side && size === ' medio' ? [faixa, rotulo] : [rotulo, faixa];
    }

    /** Ocupado anônimo na grade: "Ocupado" e o horário (já recortado em 09:00-20:00). */
    function busyBlock(n, iv, lane, px) {
      var height = durationPx(iv[1] - iv[0]);
      var side = isSide(lane);
      var size = C.blockSize(height, side);
      // Já aconteceu: cinza bem clarinho, quase apagado (não importa mais).
      var gone = isGone(n, iv[1]) ? ' bloco-passado' : '';
      return el('div', {
        class: 'bloco' + size + (side ? ' lado' : '') + gone,
        style: blockStyle(iv[0], iv[1], lane, px),
        title: 'Ocupado das ' + C.formatTime(iv[0]) + ' às ' + C.formatTime(iv[1]),
        'aria-hidden': 'true'
      }, blockContent('Ocupado', iv[0], iv[1], size, side));
    }

    /**
     * Reunião em destaque na grade: azul, com o título em negrito e o horário
     * REAL (08:30 a 09:30 é desenhada a partir das 09:00, mas escrita 08:30 a
     * 09:30). Desenhada depois do ocupado; se os dois se sobrepõem, ficam lado
     * a lado (laneLayout). O formato sai da altura (C.highlightLayout) e o
     * horário sempre aparece inteiro.
     */
    function highlightBlock(n, h, lane, px) {
      var height = durationPx(h.ve - h.vs);
      var side = isSide(lane);
      var layout = C.highlightLayout(height, side);
      var size = layout.size;
      var style = blockStyle(h.vs, h.ve, lane, px);
      // Bloco alto: o título quebra em quantas linhas couberem acima do horário.
      if (size === ' alto') style['--linhas'] = String(layout.lines);
      return el('div', {
        class: 'bloco destaque destaque-' + h.tag + size + (side ? ' lado' : '') + (isGone(n, h.e) ? ' destaque-passado' : ''),
        style: style,
        title: C.describeHighlight(h),
        'aria-hidden': 'true'
      }, blockContent(h.t, h.s, h.e, size, side));
    }

    /**
     * Blocos do dia: o ocupado anônimo (num dia bloqueado inteiro, nenhum: as
     * listras já dizem) e depois as reuniões em destaque, com as pistas
     * calculadas juntas para nenhum bloco cobrir outro.
     */
    function appendBlocks(col, d, n, full, px) {
      var busy = full ? [] : C.visibleBusyForDay(d, n);
      var marks = C.visibleHighlightsForDay(d, n);
      var lanes = C.laneLayout(busy.concat(marks.map(function (h) { return [h.vs, h.ve]; })));
      busy.forEach(function (iv, k) { col.appendChild(busyBlock(n, iv, lanes[k], px)); });
      marks.forEach(function (h, k) { col.appendChild(highlightBlock(n, h, lanes[busy.length + k], px)); });
    }

    /**
     * Grade da semana. Sem dados (state.data null) desenha o esqueleto: os
     * cabeçalhos dos dias, as horas e as colunas vazias, enquanto a senha salva
     * decifra o arquivo; depois o morph só acrescenta o que faltava. Onde
     * começa uma semana nova (a segunda depois do sábado; com filtro, qualquer
     * troca de semana), cabeçalho e coluna ganham 'nova-semana': o CSS desenha
     * ali a barra grossa colorida, da altura do cabeçalho e da grade.
     */
    function renderWeekGrid(days) {
      var d = state.data, now = state.now;
      var breaks = C.weekBreaks(days);
      var bounds = C.gridBounds();
      var hours = (bounds.end - bounds.start) / 60;
      function px(m) { return ((m - bounds.start) / 60) * HOUR_PX; }

      var head = el('div', { class: 'grade-cab' }, [el('div', { class: 'canto', 'aria-hidden': 'true' })]);
      var body = el('div', { class: 'grade-corpo' });
      var gutter = el('div', { class: 'horas', 'aria-hidden': 'true' });
      for (var h = bounds.start; h <= bounds.end; h += 60) {
        gutter.appendChild(el('span', { class: 'hora', style: { top: px(h) + 'px' }, text: C.formatTime(h) }));
      }
      body.appendChild(gutter);

      for (var i = 0; i < days.length; i++) {
        var n = days[i];
        var wd = C.isoWeekday(n);
        var inRange = !d || C.isInRange(d, n);
        var full = !!d && inRange && C.isFullDay(d, n);
        var cls = [];
        if (wd >= 6) cls.push('fds');
        if (n === today()) cls.push('hoje');
        if (!inRange) cls.push('fora');
        if (full) cls.push('indisp');
        if (n < today()) cls.push('passou');
        if (breaks[i]) cls.push('nova-semana');

        head.appendChild(el('div', {
          class: 'dia-cab ' + cls.join(' '),
          'aria-current': n === today() ? 'date' : null
        }, [
          el('span', { class: 'dsem', text: C.formatDayShort(n).split(',')[0] }),
          el('span', { class: 'dnum', text: C.formatDDMM(n) }),
          breaks[i] ? el('span', { class: 'sr-only', text: ', nova semana' }) : null
        ]));

        if (!d) {
          body.appendChild(el('div', { class: 'dia-col ' + cls.join(' ') }));
          continue;
        }

        var col = el('div', { class: 'dia-col ' + cls.join(' ') }, [
          el('p', { class: 'sr-only', text: busySummary(d, n) })
        ]);

        if (!inRange) {
          col.appendChild(el('div', { class: 'cobre cobre-fora', 'aria-hidden': 'true' }, [el('span', { text: 'Fora do período publicado' })]));
        } else if (full) {
          col.appendChild(el('div', { class: 'cobre cobre-indisp', 'aria-hidden': 'true', title: 'Dia indisponível' }, [el('span', { text: 'Dia indisponível' })]));
          // Reunião em destaque num dia bloqueado inteiro ainda aparece, por cima das listras.
          appendBlocks(col, d, n, true, px);
        } else {
          appendBlocks(col, d, n, false, px);
          if (n < today()) {
            col.appendChild(el('div', { class: 'passado', style: { top: '0', height: '100%' }, 'aria-hidden': 'true' }));
          } else if (n === today()) {
            var cut = C.clamp(now.minutes, bounds.start, bounds.end);
            if (cut > bounds.start) {
              col.appendChild(el('div', { class: 'passado', style: { top: '0', height: px(cut) + 'px' }, 'aria-hidden': 'true' }));
            }
            if (now.minutes > bounds.start && now.minutes < bounds.end) {
              col.appendChild(el('div', { class: 'agora', style: { top: px(now.minutes) + 'px' }, title: 'Agora', 'aria-hidden': 'true' }));
            }
          }
        }
        body.appendChild(col);
      }

      return el('div', { class: 'grade', style: { '--horas': String(hours), '--altura-hora': HOUR_PX + 'px' } }, [head, body]);
    }

    // ------------------------------------------------------ visão lista (celular)

    /** Item do celular. Destaque: etiqueta azul com o nome (NASA), horário real e título. */
    function itemNode(d, n, it) {
      var past = isGone(n, it.e) ? ' item-passado' : '';
      if (it.tipo === 'destaque') {
        return el('li', { class: 'item item-destaque destaque-' + it.tag + past, title: C.describeHighlight(it) }, [
          el('span', { class: 'tag', text: C.tagLabel(d, it.tag) }),
          el('span', { class: 'faixa', text: C.formatRange(it.s, it.e) }),
          el('span', { class: 'titulo', text: it.t })
        ]);
      }
      return el('li', { class: 'item item-' + it.tipo + past }, [
        el('span', { class: 'tag', text: it.tipo === 'ocupado' ? 'Ocupado' : 'Livre' }),
        el('span', { class: 'faixa', text: C.formatRange(it.s, it.e) })
      ]);
    }

    function highlightItems(d, n) {
      return C.visibleHighlightsForDay(d, n).map(function (h) {
        return { tipo: 'destaque', s: h.s, e: h.e, t: h.t, tag: h.tag };
      });
    }

    function itemList(d, n, items) {
      var ul = el('ul', { class: 'itens' });
      items.forEach(function (it) { ul.appendChild(itemNode(d, n, it)); });
      return ul;
    }

    /**
     * Lista do celular, um cartão por dia. Sem dados: o esqueleto, só com o
     * título de cada dia. Entre dois dias de semanas diferentes (o sábado e a
     * segunda; com filtro, qualquer troca de semana) entra a faixa "Nova semana".
     */
    function renderDayList(days) {
      var d = state.data, now = state.now;
      var breaks = C.weekBreaks(days);
      var list = el('ol', { class: 'lista-dias' });
      for (var i = 0; i < days.length; i++) {
        var n = days[i];
        var wd = C.isoWeekday(n);
        if (breaks[i]) list.appendChild(el('li', { class: 'semana-sep' }, [el('span', { text: 'Nova semana' })]));
        var cls = ['cartao'];
        if (wd >= 6) cls.push('fds');
        if (n === today()) cls.push('hoje');
        if (n < today()) cls.push('passou');
        var titleChildren = [C.formatDayShort(n)];
        if (n === today()) titleChildren.push(el('span', { class: 'selo', text: 'Hoje' }));
        var card = el('li', { class: cls.join(' '), 'aria-current': n === today() ? 'date' : null }, [
          el('h3', null, titleChildren)
        ]);

        if (!d) {
          list.appendChild(card);
          continue;
        }

        if (!C.isInRange(d, n)) {
          card.classList.add('fora');
          card.appendChild(el('p', { class: 'nota', text: 'Fora do período publicado' }));
        } else if (C.isFullDay(d, n)) {
          card.classList.add('indisp');
          card.appendChild(el('p', { class: 'nota nota-indisp', text: 'Dia indisponível' }));
          var marked = highlightItems(d, n);
          if (marked.length) card.appendChild(itemList(d, n, marked));
        } else {
          var items = C.visibleBusyForDay(d, n).map(function (iv) { return { tipo: 'ocupado', s: iv[0], e: iv[1] }; })
            .concat(highlightItems(d, n))
            .concat(C.freeRangesForDay(d, n, now).map(function (iv) { return { tipo: 'livre', s: iv[0], e: iv[1] }; }));
          items.sort(function (a, b) { return a.s - b.s || a.e - b.e; });

          if (n < today()) card.appendChild(el('p', { class: 'nota', text: 'Este dia já passou.' }));
          else if (!C.isWorkday(d, n)) card.appendChild(el('p', { class: 'nota', text: 'Fora dos dias de horário comercial: horários livres não são listados.' }));
          else if (n === today() && !items.some(function (it) { return it.tipo === 'livre'; })) {
            card.appendChild(el('p', { class: 'nota', text: 'Não há mais horário livre hoje dentro do horário comercial.' }));
          }

          if (items.length) {
            card.appendChild(itemList(d, n, items));
          } else if (n >= today()) {
            card.appendChild(el('p', { class: 'nota', text: 'Nenhum horário ocupado.' }));
          }
        }
        list.appendChild(card);
      }
      return list;
    }

    /** Filtro ligado e nenhuma call da etiqueta de hoje até o fim do período. */
    function renderEmpty() {
      var label = C.tagLabel(state.data, state.filter.tag);
      return el('div', { class: 'vazio', role: 'status' }, [
        el('p', { class: 'vazio-titulo', text: C.filterTexts(label).vazio }),
        el('p', { text: 'Use o botão ' + label + ', no topo, para voltar à agenda completa.' })
      ]);
    }

    /** Troca o conteúdo de #semana, mexendo só nas diferenças quando a visão é a mesma. */
    function showView(view) {
      var cur = els.semana.childNodes.length === 1 ? els.semana.firstChild : null;
      if (cur && sameKind(cur, view) && cur.className === view.className) {
        morph(cur, view);
      } else {
        els.semana.textContent = '';
        els.semana.appendChild(view);
      }
    }

    /** Redesenha a tabela. Aplica só as diferenças (morph), para o redesenho de cada minuto não recriar nós. */
    function renderCalendar() {
      if (!state.data) return;
      state.shown = currentDays();
      updateNav();
      showView(!state.shown.length ? renderEmpty()
        : (state.wide ? renderWeekGrid(state.shown) : renderDayList(state.shown)));
    }

    function isWide() {
      return mq ? mq.matches : window.innerWidth >= 768;
    }

    /**
     * Com senha salva, enquanto a chave é derivada: a página de sempre, já com
     * o cabeçalho, a navegação desligada e a grade (ou os cartões do celular)
     * VAZIA, nos dias que vão aparecer (de hoje em diante). Ao decifrar, init
     * preenche por cima; se a senha salva não abrir, volta para o portão.
     */
    function renderSkeleton() {
      state.loading = true;
      state.now = C.nowInZone(new Date(), DEFAULT_ZONE);
      state.wide = isWide();
      var days = C.viewDays(today());
      els.semanaTitulo.textContent = 'Semana de ' + C.formatWeekLabel(today());
      els.ir.value = C.formatDay(days[0]);
      els.semana.setAttribute('aria-busy', 'true');
      showView(state.wide ? renderWeekGrid(days) : renderDayList(days));
      els.portao.hidden = true;
      els.app.hidden = false;
    }

    /** Tira o esqueleto (a senha salva não abriu, falhou ou a pessoa saiu). */
    function clearSkeleton() {
      if (!state.loading) return;
      state.loading = false;
      els.semana.removeAttribute('aria-busy');
      els.semana.textContent = '';
      els.ir.value = '';
    }

    // -------------------------------------------------------------- relógio

    /**
     * Virou o dia: a tabela e o campo de data andam para o novo hoje, mas só se
     * ainda estavam no padrão (começando no hoje antigo). O que o usuário
     * escolheu fica. Campo em foco nunca é tocado.
     */
    function rollDefaults(prevDay) {
      var d = state.data;
      if (!editingIr && C.parseDay(els.ir.value) === C.clampDay(d, prevDay)) els.ir.value = '';
      if (state.week === C.defaultStart(d, prevDay)) state.week = C.defaultStart(d, today());
    }

    /** A cada minuto: a sombra do passado e a linha do agora andam; a tabela muda só no que mudou. */
    function tick() {
      if (!state.data) return;
      var n = C.nowInZone(new Date(), state.data.timezone);
      var prev = state.now;
      if (n.day === prev.day && n.minutes === prev.minutes) return;
      state.now = n;
      els.aviso.hidden = !C.isStale(state.data.generatedAtMs, Date.now());
      if (n.day !== prev.day) rollDefaults(prev.day);
      renderCalendar();
    }

    function applyViewport() {
      var wide = isWide();
      if (wide === state.wide && state.week !== null) return;
      state.wide = wide;
      if (state.data) renderCalendar();
      else if (state.loading) renderSkeleton();
    }

    // ---------------------------------------------------------------- início

    /**
     * Mostra a agenda já decifrada. Pode rodar de novo depois de "Sair" e uma
     * nova senha: o estado é refeito aqui (os ouvintes entram uma vez só, em
     * wire). A tabela começa hoje (limitada ao período), mesmo com o período
     * começando no passado.
     */
    function init(data) {
      state.data = data;
      state.loading = false;
      state.now = C.nowInZone(new Date(), data.timezone);
      state.wide = isWide();
      state.week = C.defaultStart(data, today());
      state.filter = null;
      els.semana.removeAttribute('aria-busy');
      updateHeader();
      renderCalendar();
    }

    /** Ouvintes, uma vez só. Todos conferem state.data: sem agenda aberta não fazem nada. */
    function wire() {
      // Recarregar = Cmd+Shift+R: abre a página de novo por um endereço inédito,
      // então nada vem do cache (os CSS/JS têm ?v=hash e os dados vêm com
      // no-store). A senha salva continua valendo.
      els.recarregar.addEventListener('click', function () {
        location.replace(location.pathname + '?r=' + Date.now() + location.hash);
      });

      // Teclado em qualquer ponto da página, sem modificador: setas ← → andam a
      // tabela, como os botões ‹ ›; Enter faz o mesmo que "Hoje" (com filtro, a
      // primeira página). Dentro de um campo (data, senha, texto), de um
      // contenteditable ou do formulário da senha a tecla continua do campo: o
      // Enter da data grava a data e o da senha entra. Enter num botão focado
      // (o ‹ que acabou de ser clicado, por exemplo) também vale "Hoje"; o
      // Espaço continua apertando o botão. Num link o Enter segue o link (o
      // "Pular para a agenda" só funciona com ele).
      document.addEventListener('keydown', function (ev) {
        if (!state.data || ev.defaultPrevented) return;
        if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
        var t = ev.target;
        var tag = t && t.tagName ? t.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
        if (ev.key === 'Enter') {
          if (t && t.nodeType === 1 && (els.formSenha.contains(t) || t.closest('a[href]'))) return;
          ev.preventDefault();
          goToday();
        } else if (ev.key === 'ArrowLeft' && !els.anterior.disabled) {
          ev.preventDefault();
          step(-1);
        } else if (ev.key === 'ArrowRight' && !els.proxima.disabled) {
          ev.preventDefault();
          step(1);
        }
      });
      els.anterior.addEventListener('click', function () { step(-1); });
      els.proxima.addEventListener('click', function () { step(1); });
      els.hoje.addEventListener('click', goToday);
      // Enquanto digita, só a tabela acompanha (com a data limitada ao período);
      // o campo é regravado no blur ou no Enter.
      els.ir.addEventListener('change', function () {
        var n = C.parseDay(els.ir.value);
        if (isNaN(n) || !state.data) return;
        // Com filtro: a página com o primeiro dia >= a data escolhida.
        if (state.filter) { jumpFilterTo(C.clampDay(state.data, n)); return; }
        // A data escolhida é o PRIMEIRO dia da tabela, não a semana que a contém.
        setStart(C.clampDay(state.data, n));
      });
      els.ir.addEventListener('focus', function () { editingIr = true; });
      els.ir.addEventListener('blur', function () { editingIr = false; commitIr(); });
      els.ir.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') commitIr(); });

      if (mq) {
        if (mq.addEventListener) mq.addEventListener('change', applyViewport);
        else if (mq.addListener) mq.addListener(applyViewport);
      } else {
        window.addEventListener('resize', applyViewport);
      }
      setInterval(tick, 30000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
      els.sair.addEventListener('click', lock);
    }

    // ------------------------------------------------------- senha (portão)

    var STORAGE_KEY = 'agendaMarco.senha';
    // request: o download do envelope (uma vez só; decifrar de novo, depois de
    // "Sair", não baixa de novo). ticket: muda a cada "Sair", para uma senha
    // salva que ainda estava decifrando não abrir a agenda depois disso.
    var gate = { request: null, busy: false, ticket: 0 };

    // localStorage pode não existir ou lançar (aba anônima, dados bloqueados):
    // aí a senha vale só enquanto a página estiver aberta.
    function readSavedPassword() {
      try {
        var v = window.localStorage.getItem(STORAGE_KEY);
        return typeof v === 'string' && v ? v : null;
      } catch (e) { return null; }
    }
    function savePassword(pw) {
      try { window.localStorage.setItem(STORAGE_KEY, pw); } catch (e) { /* sem armazenamento */ }
    }
    function forgetPassword() {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nada salvo */ }
    }

    function focusQuiet(node) {
      try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
    }

    /** Uma das telas do portão: 'senha' ou 'falha'. A agenda (ou o esqueleto) some. */
    function showGate(mode) {
      clearSkeleton();
      els.app.hidden = true;
      els.portao.hidden = false;
      els.formSenha.hidden = mode !== 'senha';
      els.portaoFalha.hidden = mode !== 'falha';
    }

    function setPasswordVisible(show) {
      els.senha.type = show ? 'text' : 'password';
      els.mostrar.textContent = show ? 'Ocultar' : 'Mostrar';
      els.mostrar.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    }

    /** Enquanto o PBKDF2 roda: campo só leitura, botão "Verificando…", Enter ignorado. */
    function setBusy(on) {
      gate.busy = on;
      els.formSenha.setAttribute('aria-busy', on ? 'true' : 'false');
      els.senha.readOnly = on;
      els.entrar.setAttribute('aria-disabled', on ? 'true' : 'false');
      els.entrar.textContent = on ? 'Verificando…' : 'Entrar';
    }

    /**
     * Portão: só o campo da senha, Mostrar e Entrar. changed = a senha salva
     * não abriu mais o arquivo (foi trocada no app): o aviso vai na linha de erro.
     */
    function askPassword(changed) {
      setBusy(false);
      setPasswordVisible(false);
      els.senha.value = '';
      els.senhaErro.textContent = changed ? 'A senha foi alterada. Digite a nova senha.' : '';
      showGate('senha');
      focusQuiet(els.senha);
    }

    function showFailure(message) {
      showGate('falha');
      els.portaoFalha.textContent = '';
      els.portaoFalha.appendChild(el('p', { class: 'erro-titulo', text: 'Não foi possível abrir a agenda agora.' }));
      els.portaoFalha.appendChild(el('p', { text: message }));
    }

    function loadErrorMessage(err) {
      if (location.protocol === 'file:') {
        return 'A página foi aberta direto do disco. Sirva a pasta com "python3 -m http.server 8899 --bind 127.0.0.1" e abra http://127.0.0.1:8899.';
      }
      if (err && err.code) return err.message;
      if (err instanceof SyntaxError) return 'O arquivo da agenda está corrompido ou incompleto.';
      if (err && err.name === 'TypeError') return 'Verifique sua conexão e tente recarregar a página em alguns instantes.';
      return err && err.message ? err.message : 'Erro desconhecido.';
    }

    /**
     * O envelope cifrado, baixado uma vez só. Formato errado falha aqui, antes
     * de qualquer senha (senha nenhuma resolveria).
     */
    function envelope() {
      if (!gate.request) {
        gate.request = fetch('dados/ocupado.enc.json?t=' + Date.now(), { cache: 'no-store' })
          .then(function (r) {
            if (r.status === 404) {
              var missing = new Error('A agenda ainda não foi publicada. Tente recarregar a página mais tarde.');
              missing.code = 'arquivo';
              throw missing;
            }
            if (!r.ok) throw new Error('O servidor respondeu com o código ' + r.status + '.');
            return r.json();
          })
          .then(function (enc) {
            C.parseEnvelope(enc);
            return enc;
          });
      }
      return gate.request;
    }

    /** Texto aberto -> agenda na tela. normalizeData lança se o conteúdo for inválido. */
    function openAgenda(raw) {
      var data = C.normalizeData(raw);
      init(data);
      els.portao.hidden = true;
      els.app.hidden = false;
    }

    function tryPasswords(env, list, i) {
      return C.decryptPayload(env, list[i]).then(function (raw) {
        return { raw: raw, password: list[i] };
      }, function (err) {
        if (err && err.code === 'senha' && i + 1 < list.length) return tryPasswords(env, list, i + 1);
        throw err;
      });
    }

    /** Entrar. Se o envelope ainda estiver baixando, espera por ele. */
    function onPasswordSubmit(ev) {
      ev.preventDefault();
      if (gate.busy) return;
      var candidates = C.passwordCandidates(els.senha.value);
      if (!candidates.length) {
        els.senhaErro.textContent = 'Digite a senha.';
        focusQuiet(els.senha);
        return;
      }
      // Limpa antes: o mesmo "Senha incorreta." duas vezes seguidas é lido de novo.
      els.senhaErro.textContent = '';
      setBusy(true);
      envelope().then(function (env) {
        return tryPasswords(env, candidates, 0);
      }).then(function (ok) {
        // "A senha fica salva uma vez inserida": guarda sempre, sem perguntar.
        savePassword(ok.password);
        setBusy(false);
        els.senha.value = '';
        setPasswordVisible(false);
        openAgenda(ok.raw);
        focusQuiet(els.titulo);
      }).catch(function (err) {
        setBusy(false);
        if (err && err.code === 'senha') {
          els.senhaErro.textContent = 'Senha incorreta.';
          focusQuiet(els.senha);
          try { els.senha.select(); } catch (e) { /* sem seleção */ }
        } else {
          showFailure(loadErrorMessage(err));
        }
      });
    }

    /** "Sair": esquece a senha deste navegador, apaga a agenda da tela e volta ao portão. */
    function lock() {
      gate.ticket++;
      forgetPassword();
      state.data = null;
      state.week = null;
      state.filter = null;
      state.shown = [];
      editingIr = false;
      removeTagButtons();
      [els.anterior, els.hoje, els.proxima, els.ir].forEach(function (b) { b.disabled = true; });
      els.ir.value = '';
      els.semana.textContent = '';
      askPassword(false);
    }

    els.formSenha.addEventListener('submit', onPasswordSubmit);
    els.mostrar.addEventListener('click', function () { setPasswordVisible(els.senha.type === 'password'); });

    /**
     * Início. Com senha salva, a página de sempre aparece na hora, com a grade
     * vazia (esqueleto), e enche quando a senha decifra o arquivo; se ela não
     * abrir mais (foi trocada no app), esquece e mostra o portão com o aviso.
     * Sem senha salva, o portão aparece direto, enquanto o envelope baixa.
     */
    function load() {
      var saved = readSavedPassword();
      var ticket = gate.ticket;
      if (saved) renderSkeleton(); else askPassword(false);
      envelope().then(function (env) {
        if (!saved || ticket !== gate.ticket) return null;
        return C.decryptPayload(env, saved).then(function (raw) {
          if (ticket === gate.ticket) openAgenda(raw);
        }, function (err) {
          if (ticket !== gate.ticket) return;
          if (err && err.code === 'senha') { forgetPassword(); askPassword(true); return; }
          throw err;
        });
      }).catch(function (err) { showFailure(loadErrorMessage(err)); });
    }

    wire();
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
