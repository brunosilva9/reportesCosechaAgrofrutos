import { useState } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, doc, getDoc, documentId } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import './GroupReport.css';

const MONTH_NAMES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

const fmtDate = (d) => {
  const [, mm, dd] = d.split('-');
  return `${parseInt(dd)}-${MONTH_NAMES[parseInt(mm) - 1]}`;
};

// "LM-267" → "LM",  "SF-200" → "SF"
const getPrefix = (idQr = '') => {
  const m = idQr.match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : 'OTROS';
};

// 0-based col index → Excel letter (0→A, 3→D, 26→AA …)
const col = (idx) => {
  let s = '', n = idx + 1;
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
};

const GroupReport = () => {
  const [startDate,   setStartDate]   = useState('');
  const [endDate,     setEndDate]     = useState('');
  const [priceKg,     setPriceKg]     = useState('');
  const [priceJornal, setPriceJornal] = useState('');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');

  const parseDate = (s) => { const [y,m,d] = s.split('-'); return new Date(Date.UTC(y,m-1,d)); };

  const getDateRange = (start, end) => {
    const dates = [];
    let cur = parseDate(start);
    const last = parseDate(end);
    while (cur <= last) {
      const y = cur.getUTCFullYear();
      const m = String(cur.getUTCMonth()+1).padStart(2,'0');
      const d = String(cur.getUTCDate()).padStart(2,'0');
      dates.push(`${y}-${m}-${d}`);
      cur.setUTCDate(cur.getUTCDate()+1);
    }
    return dates;
  };

  const generateReport = async () => {
    if (!startDate || !endDate) { setError('Por favor ingresa ambas fechas.'); return; }
    const kg     = Number(priceKg);
    const jornal = Number(priceJornal);
    if (!priceKg     || isNaN(kg)     || kg     <= 0) { setError('Ingresa el precio por kilaje.');   return; }
    if (!priceJornal || isNaN(jornal) || jornal <= 0) { setError('Ingresa el monto de jornal.');     return; }

    setLoading(true);
    setError('');

    try {
      // ── 1. Entries ───────────────────────────────────────────────────
      const dateRange = getDateRange(startDate, endDate);
      const entriesByDate = await Promise.all(dateRange.map(async (date) => {
        const ref  = doc(db, 'weights', date);
        const snap = await getDoc(ref);
        if (!snap.exists()) return [];
        const sub = await getDocs(collection(ref, 'entry'));
        return sub.docs.map(d => ({ ...d.data(), fecha: date }));
      }));
      const allEntries = entriesByDate.flat();

      if (!allEntries.length) {
        setError('No se encontraron pesajes en el rango de fechas.');
        setLoading(false);
        return;
      }

      // ── 2. Workers — doc ID = RUT (no hay campo "rut" en el documento) ──
      const ruts       = [...new Set(allEntries.map(e => e.rut))];
      const workerInfo = new Map(); // rut → { name, groupLeader }

      for (let i = 0; i < ruts.length; i += 10) {
        const batch = ruts.slice(i, i + 10);
        const snap  = await getDocs(
          query(collection(db, 'worker'), where(documentId(), 'in', batch))
        );
        snap.forEach(d => {
          const data = d.data();
          // groupLeader is stored as an array: ["Chilenos"]
          const gl = Array.isArray(data.groupLeader) ? data.groupLeader[0] : data.groupLeader;
          workerInfo.set(d.id, { name: data.name || 'Sin nombre', groupLeader: gl || 'Sin grupo' });
        });
      }
      // Fallback for workers not found
      ruts.forEach(r => { if (!workerInfo.has(r)) workerInfo.set(r, { name: 'Desconocido', groupLeader: 'Sin grupo' }); });

      // ── 3. Build structure: prefix → groupLeader → rut → { name, idQr, amounts{date→kg} } ──
      const prefixGroups = {};
      for (const entry of allEntries) {
        const prefix = getPrefix(entry.idQr);
        const { groupLeader, name } = workerInfo.get(entry.rut);
        prefixGroups[prefix] ??= {};
        prefixGroups[prefix][groupLeader] ??= {};
        const w = prefixGroups[prefix][groupLeader];
        w[entry.rut] ??= { name, idQr: entry.idQr, amounts: {} };
        w[entry.rut].amounts[entry.fecha] = (w[entry.rut].amounts[entry.fecha] || 0) + (entry.amount || 0);
      }

      // ── 4. Excel ─────────────────────────────────────────────────────
      const workbook = XLSX.utils.book_new();

      for (const [prefix, leaderGroups] of Object.entries(prefixGroups)) {
        // All dates that appear in this prefix, sorted
        const dates = [...new Set(
          Object.values(leaderGroups).flatMap(ws => Object.values(ws).flatMap(wp => Object.keys(wp.amounts)))
        )].sort();

        const nDates  = dates.length;
        const dS      = 3;           // date start col index (D)
        const dE      = dS + nDates - 1;
        const cTKg    = dE + 1;      // Total KG col
        const cTKi    = dE + 2;      // Total Kilaje col
        const cTJo    = dE + 3;      // Total Jornal col

        // ── SUMMARY (computed in JS) ──────────────────────────────────
        const summaryRows  = [];
        const grandByDate  = {};
        let grandKg = 0, grandKilaje = 0, grandJornal = 0;

        for (const [leader, workers] of Object.entries(leaderGroups)) {
          const byDate = {};
          let gKg = 0, workerDays = 0;
          for (const wp of Object.values(workers)) {
            for (const [date, amt] of Object.entries(wp.amounts)) {
              if (amt > 0) {
                byDate[date]      = (byDate[date]      || 0) + amt;
                grandByDate[date] = (grandByDate[date] || 0) + amt;
                gKg += amt;
                workerDays++;
              }
            }
          }
          const tKg = Math.round(gKg * 100) / 100;
          const tKi = Math.round(gKg * kg);
          const tJo = workerDays * jornal;
          grandKg += gKg; grandKilaje += tKi; grandJornal += tJo;
          summaryRows.push([leader, '', '', ...dates.map(d => byDate[d] ? Math.round((byDate[d])*100)/100 : ''), tKg, tKi, tJo]);
        }
        summaryRows.push([
          'TOTALES', '', '',
          ...dates.map(d => grandByDate[d] ? Math.round((grandByDate[d])*100)/100 : ''),
          Math.round(grandKg*100)/100, Math.round(grandKilaje), grandJornal,
        ]);

        // ── Build AOA ─────────────────────────────────────────────────
        const aoa = [];
        let r = 0;

        // Summary title + header
        aoa.push([`RESUMEN — ${prefix}`, '', '', ...dates.map(() => ''), '', '', '']); r++;
        aoa.push(['Cuadrilla', '', '', ...dates.map(fmtDate), 'Total KG', `$/kg: ${kg}`, `$/día: ${jornal}`]); r++;
        for (const row of summaryRows) { aoa.push(row); r++; }
        aoa.push([]); aoa.push([]); r += 2; // spacer

        // ── Detailed sub-tables ───────────────────────────────────────
        for (const [leader, workers] of Object.entries(leaderGroups)) {
          const priceR = r + 1; // 1-indexed Excel row of this sub-table's price row

          // Price row: kg price per date | empty | empty | jornal in last col
          aoa.push([leader, '', '', ...dates.map(() => kg), '', '', jornal]); r++;
          // Header row
          aoa.push(['RUT', 'Nombre', 'ID_QR', ...dates.map(fmtDate), 'Total KG', 'Total Kilaje', 'Total Jornal']); r++;

          const dataStart = r + 1;
          for (const [rut, wp] of Object.entries(workers)) {
            const wr = r + 1;
            const daily = dates.map(d => { const v = wp.amounts[d]; return v != null ? Math.round(v*100)/100 : ''; });

            const fTKg    = { t:'n', f:`SUM(${col(dS)}${wr}:${col(dE)}${wr})` };
            const fTKi    = { t:'n', f:`SUMPRODUCT(${col(dS)}${wr}:${col(dE)}${wr},${col(dS)}${priceR}:${col(dE)}${priceR})` };
            const fTJo    = { t:'n', f:`COUNTIF(${col(dS)}${wr}:${col(dE)}${wr},">0")*${col(cTJo)}${priceR}` };

            aoa.push([rut, wp.name, wp.idQr, ...daily, fTKg, fTKi, fTJo]); r++;
          }
          const dataEnd = r;

          // Subtotal row
          const sub = ['', 'SUBTOTAL', ''];
          for (let i = 0; i < nDates; i++) sub.push({ t:'n', f:`SUM(${col(dS+i)}${dataStart}:${col(dS+i)}${dataEnd})` });
          sub.push(
            { t:'n', f:`SUM(${col(cTKg)}${dataStart}:${col(cTKg)}${dataEnd})` },
            { t:'n', f:`SUM(${col(cTKi)}${dataStart}:${col(cTKi)}${dataEnd})` },
            { t:'n', f:`SUM(${col(cTJo)}${dataStart}:${col(cTJo)}${dataEnd})` },
          );
          aoa.push(sub); r++;
          aoa.push([]);   r++; // spacer between groups
        }

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [
          { wch: 14 }, { wch: 26 }, { wch: 8 },
          ...dates.map(() => ({ wch: 10 })),
          { wch: 12 }, { wch: 14 }, { wch: 14 },
        ];
        XLSX.utils.book_append_sheet(workbook, ws, prefix.substring(0, 31));
      }

      XLSX.writeFile(workbook, `reporte_${startDate}_${endDate}.xlsx`);

    } catch (err) {
      console.error(err);
      setError('Ocurrió un error al generar el reporte. Intenta nuevamente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="report-card">
      <div className="report-card-header">
        <h2>Reporte por Grupos</h2>
        <p>Selecciona el rango de fechas y descarga el archivo Excel.</p>
      </div>

      <div className="report-card-body">
        {error && (
          <div className="alert-error" role="alert">
            <span className="alert-error-icon">⚠</span>
            <span>{error}</span>
          </div>
        )}

        <div className="date-row">
          <div className="field">
            <label htmlFor="start-date">Fecha inicio</label>
            <input id="start-date" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="end-date">Fecha fin</label>
            <input id="end-date" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </div>
        </div>

        <div className="date-row">
          <div className="field">
            <label htmlFor="price-kg">Precio por kg ($)</label>
            <input
              id="price-kg" type="number" min="1" step="1" placeholder="Ej: 250"
              value={priceKg} onChange={e => setPriceKg(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="price-jornal">Jornal por día ($)</label>
            <input
              id="price-jornal" type="number" min="1" step="1" placeholder="Ej: 15000"
              value={priceJornal} onChange={e => setPriceJornal(e.target.value)}
            />
          </div>
        </div>

        <p className="field-hint">
          Los precios quedan editables en el Excel por columna/día. Los totales se recalculan automáticamente.
        </p>

        <hr className="divider" />

        <button className="btn-generate" onClick={generateReport} disabled={loading}>
          {loading ? (<><span className="spinner" />Generando reporte…</>) : <>⬇ Descargar Excel</>}
        </button>
      </div>
    </div>
  );
};

export default GroupReport;
