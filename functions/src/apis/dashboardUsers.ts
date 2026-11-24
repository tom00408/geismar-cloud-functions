import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
	initializeApp();
}

// Bootstrap-Allowlist — muss zu firestore.rules (isDashboardAdmin) passen.
// Zusätzlich ist jedes dashboardUsers-Konto mit rolle 'admin' berechtigt.
const DASHBOARD_ADMINS = ['handball@mtvgeismar.de', 'geschaeftsstelle@mtvgeismar.de'];

// Muss zu dashboard/src/data/module.ts passen ('accounts' gibt es nur über
// die Admin-Rolle, deshalb hier nicht freischaltbar).
const MODULE = ['shop', 'rundschau', 'mitglieder', 'social', 'spiele', 'bus'] as const;

// Unterbereiche je Modul — muss zu den bereich-Schlüsseln in module.ts passen.
const BEREICHE: Record<string, string[]> = {
	shop: ['bestellungen', 'widerrufe', 'produkte', 'analytics'],
	mitglieder: ['antraege', 'foev'],
	social: ['spieltage', 'spielplan', 'vereine', 'editor', 'ankuendigungen', 'timeline', 'board', 'vorlagen', 'canva'],
	spiele: ['mannschaften', 'spiele', 'gegner', 'hallen'],
};

function pruefeRechte(roh: unknown, module: unknown[]): Record<string, string[]> {
	if (roh === undefined || roh === null) return {};
	if (typeof roh !== 'object' || Array.isArray(roh)) {
		throw new HttpsError('invalid-argument', 'Ungültige Unterrechte.');
	}
	const rechte: Record<string, string[]> = {};
	for (const [modul, bereiche] of Object.entries(roh as Record<string, unknown>)) {
		const erlaubt = BEREICHE[modul];
		if (!erlaubt || !module.includes(modul) || !Array.isArray(bereiche)) {
			throw new HttpsError('invalid-argument', `Ungültige Unterrechte für ${modul}.`);
		}
		const unbekannt = bereiche.filter((b) => !erlaubt.includes(b as string));
		if (unbekannt.length) {
			throw new HttpsError('invalid-argument', `Unbekannter Bereich: ${unbekannt.join(', ')}`);
		}
		rechte[modul] = bereiche as string[];
	}
	return rechte;
}

const ROLLEN = ['admin', 'user'] as const;
type Rolle = (typeof ROLLEN)[number];

async function assertAdmin(uid: string | undefined, email: string | undefined) {
	if (!uid) {
		throw new HttpsError('unauthenticated', 'Nicht angemeldet.');
	}
	if (email && DASHBOARD_ADMINS.includes(email)) return;
	const profile = await getFirestore().doc(`dashboardUsers/${uid}`).get();
	if (profile.get('rolle') === 'admin') return;
	throw new HttpsError('permission-denied', 'Keine Berechtigung.');
}

// Legt Auth-Account + dashboardUsers-Profil an (Self-Signup ist deaktiviert,
// deshalb geht das nur serverseitig über das Admin SDK).
export const createDashboardUser = onCall(
	{ region: 'europe-west3' },
	async (request) => {
		await assertAdmin(request.auth?.uid, request.auth?.token.email ?? undefined);

		const data = request.data as {
			name?: string;
			email?: string;
			password?: string;
			rolle?: string;
			module?: unknown;
			rechte?: unknown;
			teams?: unknown;
			alleTeams?: unknown;
		};
		const name = data?.name?.trim();
		const email = data?.email?.trim();
		const password = data?.password;
		const rolle = data?.rolle;
		const module = Array.isArray(data?.module) ? data.module : [];

		if (!name || !email || !password || !rolle) {
			throw new HttpsError('invalid-argument', 'Fehlende Felder (name, email, password, rolle).');
		}
		if (password.length < 6) {
			throw new HttpsError('invalid-argument', 'Passwort zu kurz (min. 6 Zeichen).');
		}
		if (!ROLLEN.includes(rolle as Rolle)) {
			throw new HttpsError('invalid-argument', 'Ungültige Rolle.');
		}
		const unbekannt = module.filter((m) => !MODULE.includes(m as (typeof MODULE)[number]));
		if (unbekannt.length) {
			throw new HttpsError('invalid-argument', `Unbekanntes Modul: ${unbekannt.join(', ')}`);
		}
		const rechte = pruefeRechte(data?.rechte, module);
		const teams = Array.isArray(data?.teams)
			? data.teams.filter((t): t is string => typeof t === 'string')
			: [];
		const alleTeams = data?.alleTeams !== false;

		let uid: string;
		try {
			const user = await getAuth().createUser({ email, password, displayName: name });
			uid = user.uid;
		} catch (error) {
			const code = (error as { code?: string })?.code;
			if (code === 'auth/email-already-exists') {
				throw new HttpsError('already-exists', 'E-Mail ist schon vergeben.');
			}
			throw new HttpsError('internal', 'Account konnte nicht angelegt werden.');
		}

		await getFirestore().doc(`dashboardUsers/${uid}`).set({
			email,
			name,
			rolle,
			module: rolle === 'admin' ? [] : module,
			rechte: rolle === 'admin' ? {} : rechte,
			teams: rolle === 'admin' ? [] : teams,
			alleTeams: rolle === 'admin' ? true : alleTeams,
			pins: [],
		});

		return { uid };
	}
);

// Entzieht den Zugang komplett: Profil + Auth-Account löschen.
export const deleteDashboardUser = onCall(
	{ region: 'europe-west3' },
	async (request) => {
		await assertAdmin(request.auth?.uid, request.auth?.token.email ?? undefined);

		const uid = (request.data as { uid?: string })?.uid;
		if (!uid) {
			throw new HttpsError('invalid-argument', 'Fehlendes Feld (uid).');
		}
		if (uid === request.auth?.uid) {
			throw new HttpsError('failed-precondition', 'Du kannst dich nicht selbst löschen.');
		}

		await getFirestore().doc(`dashboardUsers/${uid}`).delete();
		await getAuth()
			.deleteUser(uid)
			.catch(() => {
				// Auth-Account existiert nicht (mehr) — Profil ist weg, reicht
			});

		return { ok: true };
	}
);
