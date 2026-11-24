import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

if (!getApps().length) {
	initializeApp();
}

const REGION = 'europe-west3';
const HAUPTACCOUNT_HANDLE = 'mtvgeismar';

// --- Wochenend-Vorschau & Spieltage ---
// Jeden Mittwoch: kommendes Wochenende (Fr–So) scannen.
//  1. Ein Sammel-Post mit ALLEN Spielen aller Mannschaften.
//  2. Pro erkanntem Spieltag (>= 2 Heimspiele am selben Tag in derselben
//     Halle) ein eigener Post.
// Posts landen als Entwurf (Status "idee") beim Hauptaccount; autoKey
// verhindert Dubletten, wenn die Funktion mehrfach läuft.

interface MatchDaten {
	teamId: string;
	opponentId: string;
	date: Timestamp;
	home: boolean;
	location: string;
}

function tagKey(d: Date): string {
	// Kalendertag in deutscher Zeit — UTC-Datum wäre nachts daneben
	return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

function wochentagKurz(d: Date): string {
	return d.toLocaleDateString('de-DE', { weekday: 'short', timeZone: 'Europe/Berlin' });
}

function uhrzeit(d: Date): string {
	return d.toLocaleTimeString('de-DE', {
		hour: '2-digit',
		minute: '2-digit',
		timeZone: 'Europe/Berlin',
	});
}

function datumLang(d: Date): string {
	return d.toLocaleDateString('de-DE', {
		weekday: 'long',
		day: '2-digit',
		month: '2-digit',
		timeZone: 'Europe/Berlin',
	});
}

// Kommendes Wochenende: Freitag 00:00 bis Sonntag 24:00 (Berlin, grob via UTC-Puffer)
function kommendesWochenende(jetzt: Date): { von: Date; bis: Date } {
	const d = new Date(jetzt);
	const tag = d.getDay(); // 0 So … 6 Sa
	const bisFreitag = (5 - tag + 7) % 7 || 7; // nächster Freitag, heute=Freitag -> heute nicht überspringen
	const von = new Date(d);
	von.setDate(d.getDate() + (tag === 5 ? 0 : bisFreitag));
	von.setHours(0, 0, 0, 0);
	const bis = new Date(von);
	bis.setDate(von.getDate() + 3); // Fr+Sa+So
	return { von, bis };
}

async function erzeugeWochenendPosts(): Promise<{ angelegt: string[] }> {
	const db = getFirestore();
	const { von, bis } = kommendesWochenende(new Date());

	const [matchesSnap, teamsSnap, oppsSnap, accountsSnap, postsSnap] = await Promise.all([
		db
			.collection('socialMediaMatches')
			.where('date', '>=', Timestamp.fromDate(von))
			.where('date', '<', Timestamp.fromDate(bis))
			.get(),
		db.collection('socialMediaTeams').get(),
		db.collection('socialMediaOpponents').get(),
		db.collection('socialMediaAccounts').where('handle', '==', HAUPTACCOUNT_HANDLE).limit(1).get(),
		db.collection('socialMediaPosts').where('autoKey', '>=', '').get(),
	]);

	if (accountsSnap.empty) {
		throw new HttpsError('failed-precondition', `Hauptaccount @${HAUPTACCOUNT_HANDLE} fehlt.`);
	}
	const accountId = accountsSnap.docs[0].id;
	const teamName = new Map(teamsSnap.docs.map((d) => [d.id, (d.get('name') as string) ?? '?']));
	const oppName = new Map(oppsSnap.docs.map((d) => [d.id, (d.get('name') as string) ?? '?']));
	const vorhandeneKeys = new Set(postsSnap.docs.map((d) => d.get('autoKey') as string));

	const matches = matchesSnap.docs
		.map((d) => d.data() as MatchDaten)
		.filter((m) => m.date)
		.sort((a, b) => a.date.toMillis() - b.date.toMillis());

	const angelegt: string[] = [];

	const neuerPost = async (autoKey: string, title: string, caption: string) => {
		if (vorhandeneKeys.has(autoKey)) return;
		await db.collection('socialMediaPosts').add({
			title,
			caption,
			status: 'idee',
			accountId,
			teamId: '',
			scheduledAt: null,
			canvaUrl: '',
			imageUrls: [],
			autoKey,
			createdBy: 'automatik',
			createdByName: 'Spieltag-Automatik',
			createdAt: FieldValue.serverTimestamp(),
			updatedAt: FieldValue.serverTimestamp(),
		});
		angelegt.push(title);
	};

	// 1) Wochenend-Sammelpost
	if (matches.length) {
		const zeilen = matches.map((m) => {
			const d = m.date.toDate();
			const gegner = oppName.get(m.opponentId) ?? '?';
			const team = teamName.get(m.teamId) ?? '?';
			return m.home
				? `${wochentagKurz(d)} ${uhrzeit(d)} 🏠 ${team} – ${gegner}${m.location ? ` (${m.location})` : ''}`
				: `${wochentagKurz(d)} ${uhrzeit(d)} 🚌 ${team} bei ${gegner}`;
		});
		const key = `wochenende-${tagKey(von)}`;
		await neuerPost(
			key,
			`Wochenend-Vorschau ${tagKey(von)}`,
			`Unsere Spiele am Wochenende 🔴⚪\n\n${zeilen.join('\n')}\n\nKommt vorbei und unterstützt uns! 💪`
		);
	}

	// 2) Spieltage: >= 2 Heimspiele am selben Tag in derselben Halle
	const gruppen = new Map<string, MatchDaten[]>();
	for (const m of matches) {
		if (!m.home) continue;
		const key = `${tagKey(m.date.toDate())}|${(m.location ?? '').trim().toLowerCase()}`;
		gruppen.set(key, [...(gruppen.get(key) ?? []), m]);
	}
	for (const [key, spiele] of gruppen) {
		if (spiele.length < 2) continue;
		const erster = spiele[0].date.toDate();
		const halle = spiele[0].location || 'unserer Halle';
		const zeilen = spiele.map(
			(m) => `${uhrzeit(m.date.toDate())} ${teamName.get(m.teamId) ?? '?'} – ${oppName.get(m.opponentId) ?? '?'}`
		);
		await neuerPost(
			`spieltag-${key.replace('|', '-')}`,
			`Spieltag ${datumLang(erster)} · ${halle}`,
			`🔥 HEIMSPIELTAG am ${datumLang(erster)}!\n📍 ${halle}\n\n${zeilen.join('\n')}\n\nEin Tag, mehrere Spiele — kommt vorbei! 🔴⚪`
		);
	}

	return { angelegt };
}

// Automatik: mittwochs 18:00 deutscher Zeit
export const spieltagAutomatik = onSchedule(
	{ region: REGION, schedule: 'every wednesday 18:00', timeZone: 'Europe/Berlin' },
	async () => {
		const res = await erzeugeWochenendPosts();
		console.log('Spieltag-Automatik:', res.angelegt.length, 'Posts angelegt', res.angelegt);
	}
);

// Manuell aus App/Dashboard auslösbar
export const spieltagPostsJetzt = onCall({ region: REGION }, async (request) => {
	if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Nicht angemeldet.');
	return erzeugeWochenendPosts();
});
