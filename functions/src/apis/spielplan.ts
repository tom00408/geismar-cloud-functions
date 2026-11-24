import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';

if (!getApps().length) {
	initializeApp();
}

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

// Bei Bedarf hier das Modell wechseln (braucht Vision + Structured Outputs).
const MODEL = 'gpt-5-mini';

const DASHBOARD_ADMINS = ['handball@mtvgeismar.de', 'geschaeftsstelle@mtvgeismar.de'];

// Gleiche Berechtigung wie das übrige Social-Media-Tool (siehe canva.ts).
async function assertLeitung(uid: string | undefined, email: string | undefined) {
	if (!uid) throw new HttpsError('unauthenticated', 'Nicht angemeldet.');
	if (email && DASHBOARD_ADMINS.includes(email)) return;
	const dash = await getFirestore().doc(`dashboardUsers/${uid}`).get();
	if (dash.get('rolle') === 'admin') return;
	if (((dash.get('module') as string[] | undefined) ?? []).includes('social')) return;
	const profile = await getFirestore().doc(`socialMediaUsers/${uid}`).get();
	const role = profile.get('role');
	if (role === 'admin' || role === 'vorstand' || role === 'team') return;
	throw new HttpsError('permission-denied', 'Keine Berechtigung.');
}

const SpielSchema = z.object({
	datum: z.string().describe('Spieldatum als YYYY-MM-DD'),
	uhrzeit: z.string().describe('Anwurfzeit als HH:MM (24h); leer wenn unbekannt'),
	heim: z.string().describe('Vollständiger Name der Heimmannschaft/des Heimvereins'),
	gast: z.string().describe('Vollständiger Name der Gastmannschaft/des Gastvereins'),
	halle: z.string().describe('Name der Halle/Spielstätte; leer wenn nicht angegeben'),
	ort: z.string().describe('Ort/Adresse der Halle; leer wenn nicht angegeben'),
});

const HalleSchema = z.object({
	name: z.string().describe('Name der Halle wie im Spielplan (z. B. „Hannover, SZ Misburg Halle I")'),
	adresse: z.string().describe('Straße + Hausnummer; leer wenn unbekannt'),
	ort: z.string().describe('PLZ + Ort; leer wenn unbekannt'),
});

const SpielplanSchema = z.object({
	spiele: z.array(SpielSchema),
	hallen: z
		.array(HalleSchema)
		.describe('Alle im Material vorkommenden Hallen mit Adresse (leer wenn keine erkennbar)'),
	hinweise: z
		.string()
		.describe('Kurze Hinweise auf Unklarheiten im Quellmaterial (leer wenn keine)'),
});

const ERLAUBTE_BILDTYPEN = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

// Live-Fortschritt für den Client: die Function schreibt ihren Zustand in
// socialMediaImportStatus/{importId}, der Client hört per onSnapshot mit.
function statusSchreiber(importId: string | undefined) {
	if (!importId || !/^[A-Za-z0-9-]{8,64}$/.test(importId)) {
		return async (_: Record<string, unknown>) => {};
	}
	const ref = getFirestore().doc(`socialMediaImportStatus/${importId}`);
	return async (daten: Record<string, unknown>) => {
		await ref.set({ ...daten, aktualisiert: new Date() }, { merge: true }).catch(() => {});
	};
}

// --- nuLiga-Scraping (URL-Import) ---

function nuligaUrlErlaubt(raw: string): URL {
	const u = new URL(raw);
	if (u.protocol !== 'https:' || !u.hostname.endsWith('.liga.nu')) {
		throw new HttpsError('invalid-argument', 'Nur https-Links auf *.liga.nu sind erlaubt.');
	}
	return u;
}

async function seiteLaden(url: string): Promise<string> {
	const res = await fetch(url, {
		redirect: 'follow',
		signal: AbortSignal.timeout(15_000),
		headers: { 'User-Agent': 'Mozilla/5.0 (MTV-Geismar Dashboard Spielplan-Import)' },
	});
	if (!res.ok) throw new Error(`nuLiga antwortete ${res.status}`);
	return res.text();
}

// HTML zu Text; Link-Titel (volle Hallennamen) bleiben erhalten
function htmlZuText(htmlRoh: string): string {
	let s = htmlRoh;
	s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
	s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
	// title-Attribute als Text einblenden (nuLiga packt Hallennamen dorthin)
	s = s.replace(/<a[^>]*title="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi, ' $1 ');
	s = s.replace(/<[^>]+>/g, ' ');
	s = s
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
		.replace(/&auml;/g, 'ä')
		.replace(/&ouml;/g, 'ö')
		.replace(/&uuml;/g, 'ü')
		.replace(/&Auml;/g, 'Ä')
		.replace(/&Ouml;/g, 'Ö')
		.replace(/&Uuml;/g, 'Ü')
		.replace(/&szlig;/g, 'ß')
		.replace(/&#\d+;/g, ' ');
	return s.replace(/\s+/g, ' ').trim();
}

// Zellen-/Blocktext: Tags raus, Entities auflösen, Whitespace bündeln
function zellText(htmlRoh: string): string {
	return htmlRoh
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
		.replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
		.replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
		.replace(/&szlig;/g, 'ß')
		.replace(/&#\d+;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

type ParsedSpiel = { datum: string; uhrzeit: string; heim: string; gast: string; halle: string; ort: string };
type ParsedHalle = { name: string; adresse: string; ort: string };

// Deterministischer nuLiga-Parser: die Spielplan-Tabelle (class result-set)
// ist strukturiert genug, dass wir keine KI brauchen — Sekunden statt Minuten.
// Liefert null, wenn die Seite nicht dem erwarteten Aufbau entspricht
// (dann greift der KI-Fallback).
async function nuligaDirektParsen(
	rohUrl: string,
	teamName: string,
	status: (d: Record<string, unknown>) => Promise<void>
): Promise<{ spiele: ParsedSpiel[]; hallen: ParsedHalle[]; hinweise: string; zielName: string | null } | null> {
	const u = nuligaUrlErlaubt(rohUrl);
	if (u.pathname.includes('groupPage') && !u.searchParams.has('displayDetail')) {
		u.searchParams.set('displayTyp', 'gesamt');
		u.searchParams.set('displayDetail', 'meetings');
	}
	await status({ phase: 'laden', text: 'Spielplan-Seite wird geladen …' });
	const html = await seiteLaden(u.toString());

	const tab = /<table[^>]*class="[^"]*result-set[^"]*"[^>]*>([\s\S]*?)<\/table>/.exec(html);
	if (!tab) return null;

	const spiele: ParsedSpiel[] = [];
	const courtLinks = new Map<string, string>(); // courtInfo-URL -> Hallenname
	let letztesDatum = '';

	for (const zeile of tab[1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
		const zellen = [...zeile[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1] ?? '');
		if (zellen.length < 7) continue;
		const texte = zellen.map(zellText);
		if (texte[0] === 'Tag') continue; // Kopfzeile

		const datumRoh = texte[1] || '';
		if (datumRoh) {
			const dm = datumRoh.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
			if (dm) letztesDatum = `${dm[3]}-${dm[2]!.padStart(2, '0')}-${dm[1]!.padStart(2, '0')}`;
		}
		const uhrzeit = (texte[2]?.match(/\d{1,2}:\d{2}/) ?? [''])[0] ?? '';
		const heim = texte[5] ?? '';
		const gast = texte[6] ?? '';
		if (!letztesDatum || !heim || !gast || /spielfrei/i.test(heim + gast)) continue;

		const halle = (/(?:title)="([^"]+)"/.exec(zellen[3] ?? '') ?? [])[1] ?? texte[3] ?? '';
		const link = /href="([^"]*courtInfo[^"]*)"/.exec(zellen[3] ?? '')?.[1];
		if (link && halle) {
			courtLinks.set(new URL(link.replace(/&amp;/g, '&'), u).toString(), halle);
		}

		spiele.push({ datum: letztesDatum, uhrzeit, heim, gast, halle, ort: '' });
	}
	if (!spiele.length) return null;

	// Nur Begegnungen mit eigener Beteiligung — die Gesamttabelle listet
	// die komplette Liga. Achtung: spielen mehrere Geismar-Teams in einer
	// Liga (z. B. III und IV), muss exakt das richtige gefiltert werden.
	const geismarNamen = [
		...new Set(
			spiele
				.flatMap((sp) => [sp.heim, sp.gast])
				.filter((n) => n.toLowerCase().includes('geismar'))
		),
	];
	let zielName: string | null = null;
	if (geismarNamen.length === 1) {
		zielName = geismarNamen[0]!;
	} else if (geismarNamen.length > 1) {
		// Nummer aus dem Mannschaftsnamen ableiten: „3. Herren" / „Geismar III" / „Geismar 3"
		const roemisch: Record<string, string> = { '2': 'II', '3': 'III', '4': 'IV', '5': 'V' };
		const ziffer =
			teamName.match(/\b([2-5])\b/)?.[1] ??
			Object.entries(roemisch).find(([, r]) =>
				new RegExp(`\\b${r}\\b`).test(teamName)
			)?.[0] ??
			null;
		if (ziffer) {
			const r = roemisch[ziffer]!;
			zielName =
				geismarNamen.find((n) => new RegExp(`\\b${r}\\b`).test(n)) ??
				geismarNamen.find((n) => new RegExp(`\\b${ziffer}\\b`).test(n)) ??
				null;
		} else {
			// keine Nummer im Teamnamen → erste Mannschaft = Name ohne Zusatz
			zielName =
				geismarNamen.find((n) => !/\b(II|III|IV|V|[2-5])\b/.test(n)) ?? null;
		}
	}
	const eigene = zielName
		? spiele.filter((sp) => sp.heim === zielName || sp.gast === zielName)
		: spiele.filter((sp) => `${sp.heim} ${sp.gast}`.toLowerCase().includes('geismar'));
	console.log(
		`nuLiga-Filter: teamName="${teamName}" → zielName="${zielName ?? 'alle Geismar'}" (${eigene.length} Spiele, Kandidaten: ${geismarNamen.join(' | ')})`
	);
	if (eigene.length) {
		spiele.length = 0;
		spiele.push(...eigene);
	}

	// Hallen-Adressen von den courtInfo-Seiten (parallel)
	const eintraege = [...courtLinks.entries()].slice(0, 30);
	await status({
		phase: 'laden',
		text: `Lade ${eintraege.length} Hallen-Adressen …`,
		hallenGesamt: eintraege.length,
		hallenGeladen: 0,
	});
	let geladen = 0;
	const hallen = (
		await Promise.allSettled(
			eintraege.map(async ([link, name]): Promise<ParsedHalle> => {
				const seite = await seiteLaden(link);
				geladen += 1;
				void status({
					phase: 'laden',
					text: `Lade Hallen-Adressen … (${geladen}/${eintraege.length})`,
					hallenGeladen: geladen,
					hallenGesamt: eintraege.length,
				});
				const block = /Hallenadresse<\/h2>\s*<p>([\s\S]*?)<\/p>/.exec(seite)?.[1] ?? '';
				const linien = block
					.replace(/<br\s*\/?>/gi, '\n')
					.split('\n')
					.map(zellText)
					.filter((l) => l && !l.includes('Routenplaner') && !/^(Tel|Fax|Telefon)/i.test(l));
				const ort = linien
					.slice(1)
					.join(' ')
					.replace(/\s*(Tel|Fax|Telefon)\.?:?.*$/i, '')
					.trim();
				return { name, adresse: linien[0] ?? '', ort };
			})
		)
	)
		.filter((r): r is PromiseFulfilledResult<ParsedHalle> => r.status === 'fulfilled')
		.map((r) => r.value);

	return { spiele, hallen, hinweise: '', zielName };
}

// Gruppenseite + Hallen-Detailseiten (Adressen) zu einem Textblock bündeln
async function nuligaTextHolen(
	rohUrl: string,
	status: (d: Record<string, unknown>) => Promise<void> = async () => {}
): Promise<string> {
	const u = nuligaUrlErlaubt(rohUrl);
	// Die Standard-Gruppenseite zeigt nur den aktuellen Ausschnitt —
	// „Spielplan (Gesamt)" liegt auf derselben Seite mit Zusatz-Parametern.
	if (u.pathname.includes('groupPage') && !u.searchParams.has('displayDetail')) {
		u.searchParams.set('displayTyp', 'gesamt');
		u.searchParams.set('displayDetail', 'meetings');
	}
	const seite = await seiteLaden(u.toString());
	let text = htmlZuText(seite).slice(0, 40_000);

	const courtLinks = [
		...new Set(
			[...seite.matchAll(/href="([^"]*courtInfo[^"]*)"/gi)].map((m) =>
				new URL((m[1] ?? '').replace(/&amp;/g, '&'), u).toString()
			)
		),
	].slice(0, 20);

	// Hallen-Seiten parallel laden (sequentiell kostete ~15–20s extra)
	await status({ phase: 'laden', text: `Lade ${courtLinks.length} Hallen-Seiten …`, hallenGesamt: courtLinks.length, hallenGeladen: 0 });
	let geladen = 0;
	const hallenTexte = (
		await Promise.allSettled(
			courtLinks.map(async (link) => {
				const ht = htmlZuText(await seiteLaden(link));
				geladen += 1;
				void status({ phase: 'laden', text: `Lade Hallen-Seiten … (${geladen}/${courtLinks.length})`, hallenGeladen: geladen, hallenGesamt: courtLinks.length });
				const i = ht.indexOf('Hallenverzeichnis');
				return ht.slice(Math.max(0, i), Math.max(0, i) + 900);
			})
		)
	)
		.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
		.map((r) => r.value);
	if (hallenTexte.length) {
		text += '\n\n=== HALLEN-DETAILS (courtInfo-Seiten) ===\n' + hallenTexte.join('\n---\n');
	}
	console.log(`nuLiga-Import: ${courtLinks.length} Hallen-Seiten, ${text.length} Zeichen Text`);
	return text;
}

// Spielplan (Fotos, Screenshots, kopierter Text) per KI in strukturierte
// Spiele-Liste umwandeln. Der Client zeigt eine Vorschau und legt die Spiele
// selbst in Firestore an — die Function parst nur.
export const parseSpielplan = onCall(
	{ region: 'europe-west3', secrets: [OPENAI_API_KEY], timeoutSeconds: 300, memory: '512MiB' },
	async (request) => {
		await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);

		const data = request.data as {
			text?: string;
			url?: string;
			images?: { data: string; mediaType: string }[];
			teamName?: string;
			importId?: string;
		};
		const status = statusSchreiber(data?.importId);
		let text = data?.text?.trim() ?? '';
		const url = data?.url?.trim() ?? '';
		const images = Array.isArray(data?.images) ? data.images : [];
		const teamName = data?.teamName?.trim() || 'MTV Geismar';

		if (!text && !images.length && !url) {
			throw new HttpsError('invalid-argument', 'Kein Text, keine Bilder, keine URL übergeben.');
		}

		// URL ohne Bilder/Text: erst deterministisch parsen — Sekunden statt
		// Minuten, keine KI-Kosten. KI bleibt Fallback für Layout-Änderungen.
		if (url && !text && !images.length) {
			try {
				const direkt = await nuligaDirektParsen(url, teamName, status);
				if (direkt && direkt.spiele.length) {
					console.log(
						`nuLiga-Direktparser: ${direkt.spiele.length} Spiele, ${direkt.hallen.length} Hallen (ohne KI)`
					);
					await status({
						phase: 'fertig',
						text: 'Fertig',
						spieleGefunden: direkt.spiele.length,
						hallenGefunden: direkt.hallen.length,
					});
					return direkt;
				}
				console.log('nuLiga-Direktparser ohne Treffer — KI-Fallback');
			} catch (error) {
				console.error('nuLiga-Direktparser fehlgeschlagen — KI-Fallback', error);
			}
		}

		if (url) {
			try {
				await status({ phase: 'laden', text: 'nuLiga-Seiten werden geladen …' });
				const nuligaText = await nuligaTextHolen(url, status);
				text = text ? `${text}\n\n${nuligaText}` : nuligaText;
			} catch (error) {
				if (error instanceof HttpsError) throw error;
				console.error('nuLiga-Abruf fehlgeschlagen', error);
				throw new HttpsError('unavailable', 'nuLiga-Seite konnte nicht geladen werden.');
			}
		}
		if (images.length > 8) {
			throw new HttpsError('invalid-argument', 'Maximal 8 Bilder pro Import.');
		}
		for (const img of images) {
			if (!img?.data || !ERLAUBTE_BILDTYPEN.includes(img.mediaType as never)) {
				throw new HttpsError('invalid-argument', 'Ungültiges Bildformat (JPEG/PNG/WebP/GIF).');
			}
		}

		const client = new OpenAI({ apiKey: OPENAI_API_KEY.value().trim() });

		const auftrag =
			`Extrahiere ALLE Spiele der Saison aus dem angehängten Spielplan` +
			(images.length ? ' (Bilder)' : '') +
			(text ? ` und folgendem Text:\n\n${text}` : '.') +
			`\n\nKontext: Es geht um die Mannschaft „${teamName}" (Verein MTV Geismar, Göttingen).` +
			`\nRegeln:\n` +
			`- Jede Begegnung genau einmal, chronologisch.\n` +
			`- Mannschafts-/Vereinsnamen exakt wie im Quellmaterial (inkl. II/III-Zusätze).\n` +
			`- Fehlende Jahresangaben aus dem Saisonkontext ableiten (Saison läuft über den Jahreswechsel).\n` +
			`- Halle/Ort nur übernehmen, wenn sie im Material stehen — nichts erfinden.\n` +
			`- Hallen: volle Namen verwenden (z. B. „Hannover, SZ Misburg Halle I", nicht nur Nummern);\n` +
			`  im Abschnitt HALLEN-DETAILS stehen Adressen — fülle damit die hallen-Liste.`;

		const content: OpenAI.Chat.ChatCompletionContentPart[] = [
			...images.map(
				(img): OpenAI.Chat.ChatCompletionContentPart => ({
					type: 'image_url',
					image_url: { url: `data:${img.mediaType};base64,${img.data}` },
				})
			),
			{ type: 'text', text: auftrag },
		];

		try {
			await status({ phase: 'ki', text: 'KI liest den Spielplan …', spieleGefunden: 0 });

			// Streaming: aus dem wachsenden JSON zählen wir erkannte Spiele
			// („datum"-Felder) und melden den Stand alle ~1,5s an den Client.
			const stream = client.chat.completions.stream({
				model: MODEL,
				messages: [{ role: 'user', content }],
				response_format: zodResponseFormat(SpielplanSchema, 'spielplan'),
			});
			let puffer = '';
			let zuletztGemeldet = 0;
			let zuletztZeit = 0;
			stream.on('content.delta', ({ delta }) => {
				puffer += delta;
				const gefunden = (puffer.match(/"datum"/g) ?? []).length;
				const jetzt = Date.now();
				if (gefunden > zuletztGemeldet && jetzt - zuletztZeit > 1500) {
					zuletztGemeldet = gefunden;
					zuletztZeit = jetzt;
					void status({ phase: 'ki', text: 'KI liest den Spielplan …', spieleGefunden: gefunden });
				}
			});
			const completion = await stream.finalChatCompletion();

			const message = completion.choices[0]?.message;
			if (message?.refusal) {
				throw new HttpsError('failed-precondition', 'Die KI hat die Anfrage abgelehnt.');
			}
			if (!message?.parsed) {
				throw new HttpsError('internal', 'Antwort konnte nicht geparst werden.');
			}
			await status({
				phase: 'fertig',
				text: 'Fertig',
				spieleGefunden: message.parsed.spiele.length,
				hallenGefunden: message.parsed.hallen.length,
			});
			return message.parsed;
		} catch (error) {
			await status({ phase: 'fehler', text: 'Import fehlgeschlagen' });
			if (error instanceof HttpsError) throw error;
			console.error('parseSpielplan fehlgeschlagen', error);
			throw new HttpsError('internal', 'Spielplan konnte nicht ausgelesen werden.');
		}
	}
);
