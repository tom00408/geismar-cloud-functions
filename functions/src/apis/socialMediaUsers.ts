import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
	initializeApp();
}

// Muss zur Allowlist in firestore.rules (isDashboardAdmin) passen
const DASHBOARD_ADMINS = ['handball@mtvgeismar.de', 'geschaeftsstelle@mtvgeismar.de'];

const SM_ROLES = ['admin', 'vorstand', 'team'] as const;
type SmRole = (typeof SM_ROLES)[number];

async function assertLeitung(uid: string | undefined, email: string | undefined) {
	if (!uid) {
		throw new HttpsError('unauthenticated', 'Nicht angemeldet.');
	}
	if (email && DASHBOARD_ADMINS.includes(email)) return;
	// Dashboard-Konto mit Admin-Rolle oder freigeschaltetem Social-Modul
	// (siehe dashboardUsers / firestore.rules hatModul('social')).
	const dash = await getFirestore().doc(`dashboardUsers/${uid}`).get();
	if (dash.get('rolle') === 'admin') return;
	if (((dash.get('module') as string[] | undefined) ?? []).includes('social')) return;
	const profile = await getFirestore().doc(`socialMediaUsers/${uid}`).get();
	const role = profile.get('role');
	if (role === 'admin' || role === 'vorstand') return;
	throw new HttpsError('permission-denied', 'Keine Berechtigung.');
}

// Legt Auth-Account + Firestore-Profil an (Self-Signup ist deaktiviert,
// deshalb geht das nur serverseitig über das Admin SDK).
export const createSocialMediaUser = onCall(
	{ region: 'europe-west3' },
	async (request) => {
		await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);

		const data = request.data as {
			name?: string;
			email?: string;
			password?: string;
			role?: string;
		};
		const name = data?.name?.trim();
		const email = data?.email?.trim();
		const password = data?.password;
		const role = data?.role;

		if (!name || !email || !password || !role) {
			throw new HttpsError('invalid-argument', 'Fehlende Felder (name, email, password, role).');
		}
		if (password.length < 6) {
			throw new HttpsError('invalid-argument', 'Passwort zu kurz (min. 6 Zeichen).');
		}
		if (!SM_ROLES.includes(role as SmRole)) {
			throw new HttpsError('invalid-argument', 'Ungültige Rolle.');
		}

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

		await getFirestore().doc(`socialMediaUsers/${uid}`).set({
			email,
			name,
			role,
			teams: [],
		});

		return { uid };
	}
);

// Entzieht den Zugang komplett: Firestore-Profil + Auth-Account löschen.
export const deleteSocialMediaUser = onCall(
	{ region: 'europe-west3' },
	async (request) => {
		await assertLeitung(request.auth?.uid, request.auth?.token.email ?? undefined);

		const uid = (request.data as { uid?: string })?.uid;
		if (!uid) {
			throw new HttpsError('invalid-argument', 'Fehlendes Feld (uid).');
		}
		if (uid === request.auth?.uid) {
			throw new HttpsError('failed-precondition', 'Du kannst dich nicht selbst löschen.');
		}

		await getFirestore().doc(`socialMediaUsers/${uid}`).delete();
		await getAuth()
			.deleteUser(uid)
			.catch(() => {
				// Auth-Account existiert nicht (mehr) — Profil ist weg, reicht
			});

		return { ok: true };
	}
);
