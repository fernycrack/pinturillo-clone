/**
 * ==========================================================================
 *  PINTURILLO CLONE · Servidor
 *  Node.js + Express + Socket.io
 * ==========================================================================
 *  Responsabilidades:
 *   - Servir los archivos estáticos de /public.
 *   - Gestionar salas (crear, unirse, reconectar y limpiar salas vacías).
 *   - Roles: quien crea la sala es el Administrador.
 *   - Mecánica por turnos: palabra secreta, temporizador (máx. 190 s),
 *     chat de adivinanzas, validación de aciertos y puntuación.
 *   - Retransmitir en tiempo real el dibujo del dibujante al resto.
 *
 *  Todo el estado vive en memoria (Map). Para un proyecto universitario es
 *  suficiente; si el servidor se reinicia, las salas se pierden.
 *
 *  Variables de entorno opcionales (útiles para pruebas):
 *   - PORT                 Puerto HTTP (por defecto 3000).
 *   - DURACION_TURNO       Segundos por turno. Nunca excede 190 (por defecto 190).
 *   - PAUSA_ENTRE_TURNOS   Segundos de pausa entre turnos (por defecto 7).
 * ==========================================================================
 */
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

// --------------------------------------------------------------------------
//  Configuración
// --------------------------------------------------------------------------
const PUERTO = process.env.PORT || 3000;

const CONFIG = {
  // Tiempo máximo por palabra: estrictamente 190 s (el entorno solo puede bajarlo).
  DURACION_TURNO: Math.min(190, Math.max(1, Number(process.env.DURACION_TURNO) || 190)),
  PAUSA_ENTRE_TURNOS: Math.max(1, Number(process.env.PAUSA_ENTRE_TURNOS) || 7),

  // Puntuación: el adivinador recibe entre PUNTOS_MIN y PUNTOS_MAX según el
  // tiempo restante. El dibujante recibe un % menor por cada acierto.
  PUNTOS_MIN: 50,
  PUNTOS_MAX: 500,
  FACTOR_DIBUJANTE: 0.25,

  // Límites de seguridad
  MAX_SALAS: 300,
  MAX_JUGADORES: 20,
  MAX_PALABRAS: 100,
  MAX_LONG_PALABRA: 40,
  MAX_LONG_NOMBRE: 20,
  MAX_LONG_MENSAJE: 100,
  MAX_CHAT_HISTORIAL: 60,
  MAX_LOTES_DIBUJO: 6000,
  MAX_SEGMENTOS_POR_LOTE: 300,

  // Tiempos de gracia ante desconexiones (ej. al recargar la página)
  GRACIA_DIBUJANTE_MS: 15000,
  GRACIA_ADMIN_MS: 45000,
  SALA_VACIA_MS: 10 * 60 * 1000,
};

// --------------------------------------------------------------------------
//  Estado global en memoria
// --------------------------------------------------------------------------
/** @type {Map<string, object>} código de sala -> sala */
const salas = new Map();

// --------------------------------------------------------------------------
//  Servidor HTTP + Socket.io
// --------------------------------------------------------------------------
const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor);

app.use(express.static(path.join(__dirname, 'public')));

// Ruta de salud (útil para Render / Railway)
app.get('/salud', (req, res) => {
  res.json({ ok: true, salas: salas.size });
});

// --------------------------------------------------------------------------
//  Utilidades
// --------------------------------------------------------------------------
// Alfabeto sin caracteres ambiguos (sin 0/O, 1/I)
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generarCodigo() {
  let codigo;
  do {
    codigo = '';
    for (let i = 0; i < 5; i++) {
      codigo += ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)];
    }
  } while (salas.has(codigo));
  return codigo;
}

/** Valida un código de sala (4 a 6 letras/números). Devuelve '' si es inválido. */
function limpiarCodigo(valor) {
  const codigo = String(valor ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{4,6}$/.test(codigo) ? codigo : '';
}

/** Limpia un nombre de usuario. Devuelve '' si queda vacío. */
function limpiarNombre(valor) {
  return String(valor ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CONFIG.MAX_LONG_NOMBRE);
}

/**
 * Normaliza texto para comparar respuestas: minúsculas, sin acentos
 * (la "ñ" se compara como "n"), sin signos de puntuación y con espacios simples.
 */
function normalizar(texto) {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Distancia de Levenshtein (para avisar "¡Casi!" cuando falta una letra). */
function distanciaEdicion(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previa = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      actual[j] = Math.min(actual[j - 1] + 1, previa[j] + 1, previa[j - 1] + costo);
    }
    previa = actual;
  }
  return previa[b.length];
}

/** "casa grande" -> "_ _ _ _   _ _ _ _ _" */
function crearMascara(palabra) {
  return palabra
    .split('')
    .map((c) => (/[\p{L}\p{N}]/u.test(c) ? '_' : c))
    .join(' ');
}

function contarLetras(palabra) {
  return palabra.split('').filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
}

/**
 * Puntos del adivinador: decrece linealmente con el tiempo restante.
 *   restante = DURACION_TURNO  ->  PUNTOS_MAX
 *   restante = 0               ->  PUNTOS_MIN
 */
function puntosPorTiempo(segundosRestantes) {
  const r = Math.max(0, Math.min(CONFIG.DURACION_TURNO, segundosRestantes));
  const fraccion = r / CONFIG.DURACION_TURNO;
  return Math.round(CONFIG.PUNTOS_MIN + (CONFIG.PUNTOS_MAX - CONFIG.PUNTOS_MIN) * fraccion);
}

function responder(ack, datos) {
  if (typeof ack === 'function') ack(datos);
}

// --------------------------------------------------------------------------
//  Salas y jugadores
// --------------------------------------------------------------------------
function crearJugador(sala, nombre) {
  let id;
  do {
    id = crypto.randomBytes(4).toString('hex'); // identificador público
  } while (sala.jugadores.has(id));
  return {
    id,
    token: crypto.randomBytes(16).toString('hex'), // secreto: solo lo conoce su dueño
    nombre,
    puntos: 0,
    socketId: null,
    conectado: false,
    ultimoChat: 0,
  };
}

function crearSala(codigo, nombreAdmin) {
  const sala = {
    codigo,
    adminId: null,
    jugadores: new Map(), // id -> jugador
    dibujantes: [], // ids de los jugadores designados como dibujantes (en orden)
    palabras: [], // lista secreta del admin
    fase: 'lobby', // 'lobby' | 'jugando' | 'entreturnos' | 'finalizada'
    indiceTurno: -1, // índice (0-based) del turno en curso o del último turno
    turno: null,
    historialDibujo: [], // lotes de trazos del turno actual
    chat: [], // mensajes públicos recientes
    timers: { pausa: null, graciaAdmin: null },
    vacioDesde: Date.now(),
  };
  const admin = crearJugador(sala, nombreAdmin);
  sala.adminId = admin.id;
  sala.jugadores.set(admin.id, admin);
  salas.set(codigo, sala);
  return { sala, admin };
}

function buscarPorToken(sala, token) {
  for (const jugador of sala.jugadores.values()) {
    if (jugador.token === token) return jugador;
  }
  return null;
}

function nombreEnUso(sala, nombre, ignorarId = null) {
  const buscado = nombre.toLowerCase();
  for (const j of sala.jugadores.values()) {
    if (j.id !== ignorarId && j.nombre.toLowerCase() === buscado) return true;
  }
  return false;
}

function hayConectados(sala) {
  for (const j of sala.jugadores.values()) if (j.conectado) return true;
  return false;
}

/** Contexto de un socket: { sala, jugador } o null si no está en una sala. */
function contexto(socket) {
  const { codigo, jugadorId } = socket.data || {};
  if (!codigo) return null;
  const sala = salas.get(codigo);
  if (!sala) return null;
  const jugador = sala.jugadores.get(jugadorId);
  if (!jugador || jugador.socketId !== socket.id) return null;
  return { sala, jugador };
}

function exigirAdmin(socket, ack) {
  const ctx = contexto(socket);
  if (!ctx) {
    responder(ack, { ok: false, error: 'No estás conectado a una sala.' });
    return null;
  }
  if (ctx.sala.adminId !== ctx.jugador.id) {
    responder(ack, { ok: false, error: 'Solo el administrador puede hacer esto.' });
    return null;
  }
  return ctx;
}

// --------------------------------------------------------------------------
//  Emisión de estado
// --------------------------------------------------------------------------
/** Estado público de la sala (NO incluye la palabra secreta ni la lista de palabras). */
function estadoPublico(sala) {
  const turno = sala.turno;
  const enPartida = sala.fase === 'jugando' || sala.fase === 'entreturnos';
  return {
    codigo: sala.codigo,
    fase: sala.fase,
    adminId: sala.adminId,
    dibujantes: sala.dibujantes.slice(),
    totalPalabras: sala.palabras.length,
    numeroTurno: enPartida ? sala.indiceTurno + 1 : 0,
    dibujanteActualId: turno ? turno.dibujanteId : null,
    jugadores: [...sala.jugadores.values()].map((j) => ({
      id: j.id,
      nombre: j.nombre,
      puntos: j.puntos,
      conectado: j.conectado,
      acerto: turno ? turno.acertaron.has(j.id) : false,
    })),
  };
}

function emitirEstado(sala) {
  io.to(sala.codigo).emit('sala_estado', estadoPublico(sala));
}

/** Envía un mensaje al chat de la sala. Los públicos se guardan en el historial. */
function enviarMensaje(sala, mensaje, guardar = true) {
  const completo = { autor: null, ...mensaje, hora: Date.now() };
  if (guardar) {
    sala.chat.push(completo);
    if (sala.chat.length > CONFIG.MAX_CHAT_HISTORIAL) sala.chat.shift();
  }
  io.to(sala.codigo).emit('chat_mensaje', completo);
}

function mensajeSistema(sala, texto, tipo = 'sistema') {
  enviarMensaje(sala, { texto, tipo });
}

function datosTurno(sala) {
  const t = sala.turno;
  const dibujante = sala.jugadores.get(t.dibujanteId);
  return {
    indice: sala.indiceTurno + 1,
    total: sala.palabras.length,
    dibujanteId: t.dibujanteId,
    dibujanteNombre: dibujante ? dibujante.nombre : '?',
    mascara: crearMascara(t.palabra),
    letras: contarLetras(t.palabra),
    finaliza: t.finaliza,
    duracion: CONFIG.DURACION_TURNO,
    ahora: Date.now(), // permite al cliente sincronizar su reloj con el del servidor
  };
}

function construirRanking(sala) {
  const ordenados = [...sala.jugadores.values()].sort(
    (a, b) => b.puntos - a.puntos || a.nombre.localeCompare(b.nombre, 'es')
  );
  let posicion = 0;
  let puntosPrevios = null;
  return ordenados.map((j, i) => {
    if (j.puntos !== puntosPrevios) {
      posicion = i + 1;
      puntosPrevios = j.puntos;
    }
    return { id: j.id, nombre: j.nombre, puntos: j.puntos, posicion, conectado: j.conectado };
  });
}

/** Lo que recibe un socket al (re)conectarse para ponerse al día. */
function enviarInstantanea(socket, sala, jugador) {
  socket.emit('chat_historial', sala.chat);
  if (sala.adminId === jugador.id) {
    socket.emit('admin_config', { palabras: sala.palabras });
  }
  if (sala.fase === 'jugando' && sala.turno && sala.turno.activo) {
    socket.emit('turno_inicio', datosTurno(sala));
    if (jugador.id === sala.turno.dibujanteId || sala.turno.acertaron.has(jugador.id)) {
      socket.emit('turno_palabra', { palabra: sala.turno.palabra });
    }
    socket.emit('dibujo_historial', sala.historialDibujo);
  } else if (sala.fase === 'finalizada') {
    socket.emit('juego_fin', { ranking: construirRanking(sala) });
  }
}

// --------------------------------------------------------------------------
//  Lógica de turnos
// --------------------------------------------------------------------------
function limpiarTimersTurno(sala) {
  clearTimeout(sala.timers.pausa);
  sala.timers.pausa = null;
  if (sala.turno) {
    clearTimeout(sala.turno.timeout);
    clearTimeout(sala.turno.graciaTimeout);
  }
}

/**
 * Elige al dibujante del turno actual rotando entre los dibujantes que el
 * administrador designó. Si ninguno está conectado, recurre al admin o a
 * cualquier jugador conectado para que la partida no se atasque.
 */
function elegirDibujante(sala) {
  const conectados = [...sala.jugadores.values()].filter((j) => j.conectado);
  if (!conectados.length) return null;

  const candidatos = sala.dibujantes.map((id) => sala.jugadores.get(id)).filter(Boolean);
  for (let k = 0; k < candidatos.length; k++) {
    const candidato = candidatos[(sala.indiceTurno + k) % candidatos.length];
    if (candidato.conectado) return candidato;
  }
  return conectados.find((j) => j.id === sala.adminId) || conectados[0];
}

function iniciarTurno(sala) {
  limpiarTimersTurno(sala);
  sala.indiceTurno += 1;

  if (sala.indiceTurno >= sala.palabras.length) {
    finalizarJuego(sala);
    return;
  }

  const dibujante = elegirDibujante(sala);
  if (!dibujante) {
    finalizarJuego(sala);
    return;
  }

  const palabra = sala.palabras[sala.indiceTurno];
  const ahora = Date.now();
  const duracionMs = CONFIG.DURACION_TURNO * 1000;

  sala.fase = 'jugando';
  sala.historialDibujo = [];
  sala.turno = {
    dibujanteId: dibujante.id,
    palabra,
    normalizada: normalizar(palabra),
    inicio: ahora,
    finaliza: ahora + duracionMs,
    acertaron: new Map(), // id -> puntos ganados
    puntosDibujante: 0,
    activo: true,
    timeout: setTimeout(() => finalizarTurno(sala, 'tiempo'), duracionMs),
    graciaTimeout: null,
  };

  io.to(sala.codigo).emit('dibujo_limpiar');
  io.to(sala.codigo).emit('turno_inicio', datosTurno(sala));
  if (dibujante.socketId) {
    io.to(dibujante.socketId).emit('turno_palabra', { palabra });
  }
  mensajeSistema(
    sala,
    `Turno ${sala.indiceTurno + 1} de ${sala.palabras.length}: dibuja ${dibujante.nombre}.`
  );
  emitirEstado(sala);
}

function finalizarTurno(sala, razon) {
  const t = sala.turno;
  if (!t || !t.activo) return;

  t.activo = false;
  clearTimeout(t.timeout);
  clearTimeout(t.graciaTimeout);
  sala.fase = 'entreturnos';

  // Resumen de puntos ganados en este turno
  const ganancias = [];
  for (const [id, puntos] of t.acertaron) {
    const j = sala.jugadores.get(id);
    ganancias.push({ id, nombre: j ? j.nombre : 'Jugador', puntos, esDibujante: false });
  }
  if (t.puntosDibujante > 0) {
    const dib = sala.jugadores.get(t.dibujanteId);
    ganancias.push({
      id: t.dibujanteId,
      nombre: dib ? dib.nombre : 'Dibujante',
      puntos: t.puntosDibujante,
      esDibujante: true,
    });
  }

  io.to(sala.codigo).emit('turno_fin', {
    palabra: t.palabra,
    razon,
    ganancias,
    siguienteEn: CONFIG.PAUSA_ENTRE_TURNOS,
  });
  mensajeSistema(sala, `La palabra era "${t.palabra}".`);
  emitirEstado(sala);

  const eraElUltimo = sala.indiceTurno + 1 >= sala.palabras.length;
  sala.timers.pausa = setTimeout(() => {
    sala.timers.pausa = null;
    if (eraElUltimo) finalizarJuego(sala);
    else iniciarTurno(sala);
  }, CONFIG.PAUSA_ENTRE_TURNOS * 1000);
}

function finalizarJuego(sala) {
  limpiarTimersTurno(sala);
  if (sala.turno) sala.turno.activo = false;
  sala.fase = 'finalizada';
  sala.turno = null;
  sala.historialDibujo = [];
  mensajeSistema(sala, '¡La partida ha terminado! Revisa la tabla de posiciones.');
  io.to(sala.codigo).emit('juego_fin', { ranking: construirRanking(sala) });
  emitirEstado(sala);
}

/** Si todos los adivinadores conectados ya acertaron, el turno termina antes. */
function verificarTodosAcertaron(sala) {
  const t = sala.turno;
  if (!t || !t.activo) return;
  const adivinadores = [...sala.jugadores.values()].filter(
    (j) => j.conectado && j.id !== t.dibujanteId
  );
  if (adivinadores.length > 0 && adivinadores.every((j) => t.acertaron.has(j.id))) {
    finalizarTurno(sala, 'todos');
  }
}

function registrarAcierto(sala, jugador) {
  const t = sala.turno;
  const restante = Math.max(0, (t.finaliza - Date.now()) / 1000);
  const puntos = puntosPorTiempo(restante);
  const bonus = Math.round(puntos * CONFIG.FACTOR_DIBUJANTE);

  jugador.puntos += puntos;
  t.acertaron.set(jugador.id, puntos);

  const dibujante = sala.jugadores.get(t.dibujanteId);
  if (dibujante) {
    dibujante.puntos += bonus;
    t.puntosDibujante += bonus;
  }

  mensajeSistema(sala, `🎉 ${jugador.nombre} adivinó la palabra (+${puntos} puntos).`, 'acierto');
  // Quien acierta puede ver la palabra para saber que fue correcta.
  if (jugador.socketId) io.to(jugador.socketId).emit('turno_palabra', { palabra: t.palabra });
  emitirEstado(sala);
  verificarTodosAcertaron(sala);
}

// --------------------------------------------------------------------------
//  Administración y desconexiones
// --------------------------------------------------------------------------
/** Pasa la administración a otro jugador conectado si el admin ya no está. */
function transferirAdmin(sala) {
  clearTimeout(sala.timers.graciaAdmin);
  sala.timers.graciaAdmin = null;
  const actual = sala.jugadores.get(sala.adminId);
  if (actual && actual.conectado) return;

  const nuevo = [...sala.jugadores.values()].find((j) => j.conectado && j.id !== sala.adminId);
  if (!nuevo) return;

  sala.adminId = nuevo.id;
  mensajeSistema(sala, `👑 ${nuevo.nombre} es ahora el administrador de la sala.`);
  if (nuevo.socketId) io.to(nuevo.socketId).emit('admin_config', { palabras: sala.palabras });
  emitirEstado(sala);
}

/** Marca a un jugador como desconectado y programa los tiempos de gracia. */
function manejarDesconexion(sala, jugador) {
  jugador.conectado = false;
  jugador.socketId = null;

  if (!hayConectados(sala)) sala.vacioDesde = Date.now();

  if (jugador.id === sala.adminId) {
    clearTimeout(sala.timers.graciaAdmin);
    sala.timers.graciaAdmin = setTimeout(() => transferirAdmin(sala), CONFIG.GRACIA_ADMIN_MS);
  }

  const t = sala.turno;
  if (t && t.activo) {
    if (jugador.id === t.dibujanteId) {
      // Damos unos segundos por si solo recargó la página.
      clearTimeout(t.graciaTimeout);
      t.graciaTimeout = setTimeout(() => {
        const dib = sala.jugadores.get(t.dibujanteId);
        if (!dib || !dib.conectado) finalizarTurno(sala, 'dibujante_desconectado');
      }, CONFIG.GRACIA_DIBUJANTE_MS);
    } else {
      verificarTodosAcertaron(sala);
    }
  }
  emitirEstado(sala);
}

/** Quita definitivamente a un jugador de la sala (expulsión o salida en el lobby). */
function eliminarJugador(sala, jugador, motivo) {
  const socket = jugador.socketId ? io.sockets.sockets.get(jugador.socketId) : null;
  if (socket) {
    if (motivo === 'expulsado') socket.emit('expulsado', { motivo: 'El administrador te expulsó de la sala.' });
    socket.leave(sala.codigo);
    socket.data = {};
  }

  const eraAdmin = jugador.id === sala.adminId;
  const eraDibujante = sala.turno && sala.turno.activo && sala.turno.dibujanteId === jugador.id;

  sala.jugadores.delete(jugador.id);
  sala.dibujantes = sala.dibujantes.filter((id) => id !== jugador.id);

  if (!hayConectados(sala)) sala.vacioDesde = Date.now();
  if (eraAdmin) transferirAdmin(sala);

  mensajeSistema(
    sala,
    motivo === 'expulsado' ? `${jugador.nombre} fue expulsado.` : `${jugador.nombre} salió de la sala.`
  );

  if (eraDibujante) finalizarTurno(sala, 'dibujante_desconectado');
  else verificarTodosAcertaron(sala);
  emitirEstado(sala);
}

function destruirSala(sala) {
  limpiarTimersTurno(sala);
  clearTimeout(sala.timers.graciaAdmin);
  io.in(sala.codigo).socketsLeave(sala.codigo);
  salas.delete(sala.codigo);
}

// Limpieza periódica de salas abandonadas
setInterval(() => {
  const ahora = Date.now();
  for (const sala of salas.values()) {
    if (sala.vacioDesde && !hayConectados(sala) && ahora - sala.vacioDesde > CONFIG.SALA_VACIA_MS) {
      destruirSala(sala);
    }
  }
}, 60 * 1000).unref();

// --------------------------------------------------------------------------
//  Validación de trazos del canvas
// --------------------------------------------------------------------------
/**
 * Un "lote" agrupa varios segmentos del mismo color y grosor:
 *   { color: '#rrggbb', grosor: 1..100, segs: [[x0, y0, x1, y1], ...] }
 * Las coordenadas están normalizadas (0..1) para que cada cliente las escale
 * a su propio tamaño de pantalla.
 */
function sanitizarLote(lote) {
  if (!lote || typeof lote !== 'object' || !Array.isArray(lote.segs)) return null;

  const color =
    typeof lote.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(lote.color)
      ? lote.color.toLowerCase()
      : '#000000';

  let grosor = Number(lote.grosor);
  if (!Number.isFinite(grosor)) grosor = 5;
  grosor = Math.min(100, Math.max(1, Math.round(grosor)));

  const segs = [];
  for (const s of lote.segs.slice(0, CONFIG.MAX_SEGMENTOS_POR_LOTE)) {
    if (!Array.isArray(s) || s.length !== 4) continue;
    const numeros = s.map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000 : null;
    });
    if (numeros.includes(null)) continue;
    segs.push(numeros);
  }
  return segs.length ? { color, grosor, segs } : null;
}

/** Limpia y valida la lista de palabras enviada por el administrador. */
function sanitizarPalabras(lista) {
  if (!Array.isArray(lista)) return [];
  const vistas = new Set();
  const resultado = [];
  for (const item of lista) {
    const palabra = String(item ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CONFIG.MAX_LONG_PALABRA);
    const clave = normalizar(palabra);
    if (!clave || vistas.has(clave)) continue;
    vistas.add(clave);
    resultado.push(palabra);
    if (resultado.length >= CONFIG.MAX_PALABRAS) break;
  }
  return resultado;
}

// --------------------------------------------------------------------------
//  Eventos de Socket.io
// --------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.data = {};

  // ---------------- Lobby: crear / verificar sala ----------------
  socket.on('crear_sala', (datos, ack) => {
    if (salas.size >= CONFIG.MAX_SALAS) {
      return responder(ack, { ok: false, error: 'El servidor está lleno. Intenta más tarde.' });
    }
    const nombre = limpiarNombre(datos && datos.nombre);
    if (!nombre) {
      return responder(ack, { ok: false, error: `Escribe un nombre de usuario (máx. ${CONFIG.MAX_LONG_NOMBRE} caracteres).` });
    }

    const codigoPedido = String((datos && datos.codigo) ?? '').trim();
    let codigo;
    if (codigoPedido) {
      codigo = limpiarCodigo(codigoPedido);
      if (!codigo) {
        return responder(ack, { ok: false, error: 'El código debe tener de 4 a 6 caracteres (solo letras y números).' });
      }
      if (salas.has(codigo)) {
        return responder(ack, { ok: false, error: 'Ese código ya está en uso. Elige otro o déjalo vacío.' });
      }
    } else {
      codigo = generarCodigo();
    }

    const { admin } = crearSala(codigo, nombre);
    responder(ack, { ok: true, codigo, token: admin.token });
  });

  socket.on('verificar_sala', (datos, ack) => {
    const codigo = limpiarCodigo(datos && datos.codigo);
    if (!codigo) {
      return responder(ack, { ok: false, error: 'El código debe tener de 4 a 6 caracteres (solo letras y números).' });
    }
    const sala = salas.get(codigo);
    if (!sala) return responder(ack, { ok: false, error: 'No existe ninguna sala con ese código.' });

    const nombre = limpiarNombre(datos && datos.nombre);
    if (!nombre) {
      return responder(ack, { ok: false, error: `Escribe un nombre de usuario (máx. ${CONFIG.MAX_LONG_NOMBRE} caracteres).` });
    }
    if (sala.jugadores.size >= CONFIG.MAX_JUGADORES) {
      return responder(ack, { ok: false, error: 'La sala está llena.' });
    }
    if (nombreEnUso(sala, nombre)) {
      return responder(ack, { ok: false, error: 'Ese nombre ya está en uso en la sala. Elige otro.' });
    }
    responder(ack, { ok: true, codigo });
  });

  // ---------------- Sala: unirse / reconectar ----------------
  socket.on('unirse_sala', (datos, ack) => {
    const codigo = limpiarCodigo(datos && datos.codigo);
    const sala = codigo ? salas.get(codigo) : null;
    if (!sala) return responder(ack, { ok: false, error: 'La sala no existe o ya fue cerrada.' });

    let jugador = datos && datos.token ? buscarPorToken(sala, String(datos.token)) : null;
    const esReconexion = Boolean(jugador);

    if (jugador) {
      // Si había otro socket vinculado a este jugador, lo desvinculamos.
      if (jugador.socketId && jugador.socketId !== socket.id) {
        const viejo = io.sockets.sockets.get(jugador.socketId);
        if (viejo) {
          viejo.data = {};
          viejo.leave(sala.codigo);
          viejo.emit('sesion_reemplazada');
        }
      }
    } else {
      const nombre = limpiarNombre(datos && datos.nombre);
      if (!nombre) return responder(ack, { ok: false, error: 'Escribe un nombre de usuario válido.' });
      if (sala.jugadores.size >= CONFIG.MAX_JUGADORES) return responder(ack, { ok: false, error: 'La sala está llena.' });
      if (nombreEnUso(sala, nombre)) return responder(ack, { ok: false, error: 'Ese nombre ya está en uso en la sala. Elige otro.' });
      jugador = crearJugador(sala, nombre);
      sala.jugadores.set(jugador.id, jugador);
    }

    jugador.socketId = socket.id;
    jugador.conectado = true;
    socket.data = { codigo: sala.codigo, jugadorId: jugador.id };
    socket.join(sala.codigo);
    sala.vacioDesde = null;

    // Si volvió el admin o el dibujante, cancelamos sus temporizadores de gracia.
    if (jugador.id === sala.adminId) {
      clearTimeout(sala.timers.graciaAdmin);
      sala.timers.graciaAdmin = null;
    }
    if (sala.turno && sala.turno.activo && sala.turno.dibujanteId === jugador.id) {
      clearTimeout(sala.turno.graciaTimeout);
      sala.turno.graciaTimeout = null;
    }

    responder(ack, {
      ok: true,
      id: jugador.id,
      token: jugador.token,
      nombre: jugador.nombre,
      esAdmin: sala.adminId === jugador.id,
    });

    if (!esReconexion) mensajeSistema(sala, `${jugador.nombre} se unió a la sala.`);
    emitirEstado(sala);
    enviarInstantanea(socket, sala, jugador);
  });

  socket.on('salir_sala', () => {
    const ctx = contexto(socket);
    if (!ctx) return;
    const { sala, jugador } = ctx;
    if (sala.fase === 'lobby') {
      eliminarJugador(sala, jugador, 'salio');
    } else {
      // En plena partida conservamos su puntaje; solo lo marcamos desconectado.
      socket.leave(sala.codigo);
      socket.data = {};
      manejarDesconexion(sala, jugador);
    }
  });

  // ---------------- Acciones del administrador ----------------
  socket.on('admin_renombrar', (datos, ack) => {
    const ctx = exigirAdmin(socket, ack);
    if (!ctx) return;
    const { sala } = ctx;
    const objetivo = sala.jugadores.get(String(datos && datos.id));
    if (!objetivo) return responder(ack, { ok: false, error: 'Ese jugador ya no está en la sala.' });

    const nombre = limpiarNombre(datos && datos.nombre);
    if (!nombre) return responder(ack, { ok: false, error: 'El nombre no puede estar vacío.' });
    if (nombreEnUso(sala, nombre, objetivo.id)) {
      return responder(ack, { ok: false, error: 'Ya existe un jugador con ese nombre.' });
    }

    const anterior = objetivo.nombre;
    objetivo.nombre = nombre;
    if (anterior !== nombre) mensajeSistema(sala, `${anterior} ahora se llama ${nombre}.`);
    emitirEstado(sala);
    responder(ack, { ok: true });
  });

  socket.on('admin_dibujantes', (datos, ack) => {
    const ctx = exigirAdmin(socket, ack);
    if (!ctx) return;
    const { sala } = ctx;
    const ids = Array.isArray(datos && datos.ids) ? datos.ids.map(String) : [];
    const unicos = [];
    for (const id of ids) {
      if (sala.jugadores.has(id) && !unicos.includes(id)) unicos.push(id);
    }
    sala.dibujantes = unicos;
    emitirEstado(sala);
    responder(ack, { ok: true });
  });

  socket.on('admin_palabras', (datos, ack) => {
    const ctx = exigirAdmin(socket, ack);
    if (!ctx) return;
    const { sala } = ctx;
    if (sala.fase !== 'lobby') {
      return responder(ack, { ok: false, error: 'Solo puedes editar las palabras antes de iniciar la partida.' });
    }
    sala.palabras = sanitizarPalabras(datos && datos.palabras);
    socket.emit('admin_config', { palabras: sala.palabras });
    emitirEstado(sala);
    responder(ack, { ok: true, cantidad: sala.palabras.length, palabras: sala.palabras });
  });

  socket.on('admin_expulsar', (datos, ack) => {
    const ctx = exigirAdmin(socket, ack);
    if (!ctx) return;
    const { sala } = ctx;
    const objetivo = sala.jugadores.get(String(datos && datos.id));
    if (!objetivo) return responder(ack, { ok: false, error: 'Ese jugador ya no está en la sala.' });
    if (objetivo.id === sala.adminId) return responder(ack, { ok: false, error: 'No puedes expulsarte a ti mismo.' });
    eliminarJugador(sala, objetivo, 'expulsado');
    responder(ack, { ok: true });
  });

  socket.on('admin_iniciar', (datos, ack) => {
    const ctx = exigirAdmin(socket, ack);
    if (!ctx) return;
    const { sala } = ctx;

    if (sala.fase !== 'lobby') return responder(ack, { ok: false, error: 'La partida ya está en curso.' });
    if (sala.palabras.length < 1) return responder(ack, { ok: false, error: 'Agrega al menos una palabra secreta.' });

    const conectados = [...sala.jugadores.values()].filter((j) => j.conectado);
    if (conectados.length < 2) {
      return responder(ack, { ok: false, error: 'Se necesitan al menos 2 jugadores conectados (un dibujante y un adivinador).' });
    }
    const hayDibujanteConectado = sala.dibujantes.some((id) => {
      const j = sala.jugadores.get(id);
      return j && j.conectado;
    });
    if (!hayDibujanteConectado) {
      return responder(ack, { ok: false, error: 'Asigna al menos un dibujante conectado (casilla ✏️ del panel).' });
    }

    for (const j of sala.jugadores.values()) j.puntos = 0;
    sala.indiceTurno = -1;
    sala.turno = null;
    mensajeSistema(sala, '🚀 ¡Comienza la partida!');
    responder(ack, { ok: true });
    iniciarTurno(sala);
  });

  socket.on('admin_saltar_turno', (datos, ack) => {
    const ctx = exigirAdmin(socket, ack);
    if (!ctx) return;
    if (ctx.sala.fase !== 'jugando') return responder(ack, { ok: false, error: 'No hay un turno en curso.' });
    finalizarTurno(ctx.sala, 'saltado');
    responder(ack, { ok: true });
  });

  socket.on('admin_terminar', (datos, ack) => {
    const ctx = exigirAdmin(socket, ack);
    if (!ctx) return;
    const { sala } = ctx;
    if (sala.fase !== 'jugando' && sala.fase !== 'entreturnos') {
      return responder(ack, { ok: false, error: 'No hay una partida en curso.' });
    }
    finalizarJuego(sala);
    responder(ack, { ok: true });
  });

  socket.on('admin_nueva_partida', (datos, ack) => {
    const ctx = exigirAdmin(socket, ack);
    if (!ctx) return;
    const { sala } = ctx;
    if (sala.fase !== 'finalizada') return responder(ack, { ok: false, error: 'La partida aún no termina.' });

    limpiarTimersTurno(sala);
    for (const j of sala.jugadores.values()) j.puntos = 0;
    sala.fase = 'lobby';
    sala.indiceTurno = -1;
    sala.turno = null;
    sala.historialDibujo = [];
    mensajeSistema(sala, '🔄 El administrador abrió una nueva partida.');
    io.to(sala.codigo).emit('volver_lobby');
    emitirEstado(sala);
    socket.emit('admin_config', { palabras: sala.palabras });
    responder(ack, { ok: true });
  });

  // ---------------- Dibujo en tiempo real ----------------
  socket.on('dibujo_segmentos', (lote) => {
    const ctx = contexto(socket);
    if (!ctx) return;
    const { sala, jugador } = ctx;
    const t = sala.turno;
    if (sala.fase !== 'jugando' || !t || !t.activo || t.dibujanteId !== jugador.id) return;

    const limpio = sanitizarLote(lote);
    if (!limpio) return;
    if (sala.historialDibujo.length < CONFIG.MAX_LOTES_DIBUJO) sala.historialDibujo.push(limpio);
    socket.to(sala.codigo).emit('dibujo_segmentos', limpio);
  });

  socket.on('dibujo_limpiar', () => {
    const ctx = contexto(socket);
    if (!ctx) return;
    const { sala, jugador } = ctx;
    const t = sala.turno;
    if (sala.fase !== 'jugando' || !t || !t.activo || t.dibujanteId !== jugador.id) return;

    sala.historialDibujo = [];
    socket.to(sala.codigo).emit('dibujo_limpiar');
  });

  // ---------------- Chat y adivinanzas ----------------
  socket.on('chat_mensaje', (datos) => {
    const ctx = contexto(socket);
    if (!ctx) return;
    const { sala, jugador } = ctx;

    const texto = String((datos && datos.texto) ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CONFIG.MAX_LONG_MENSAJE);
    if (!texto) return;

    // Anti-spam sencillo: un mensaje cada 400 ms como máximo
    const ahora = Date.now();
    if (ahora - jugador.ultimoChat < 400) return;
    jugador.ultimoChat = ahora;

    const t = sala.turno;
    if (sala.fase === 'jugando' && t && t.activo) {
      const esDibujante = jugador.id === t.dibujanteId;
      const yaAcerto = t.acertaron.has(jugador.id);

      // El dibujante y quienes ya acertaron chatean en privado (no se filtra la palabra).
      if (esDibujante || yaAcerto) {
        const mensaje = { autor: jugador.nombre, texto, tipo: 'privado', hora: ahora };
        const destinatarios = new Set([t.dibujanteId, ...t.acertaron.keys()]);
        for (const id of destinatarios) {
          const j = sala.jugadores.get(id);
          if (j && j.socketId) io.to(j.socketId).emit('chat_mensaje', mensaje);
        }
        return;
      }

      // ¿Es la palabra correcta? (sin importar mayúsculas ni acentos)
      const intento = normalizar(texto);
      if (intento && intento === t.normalizada) {
        registrarAcierto(sala, jugador);
        return;
      }

      // Mensaje normal; si falta/sobra una sola letra avisamos "¡Casi!" solo a quien escribió.
      enviarMensaje(sala, { autor: jugador.nombre, texto, tipo: 'normal' });
      if (t.normalizada.length >= 4 && distanciaEdicion(intento, t.normalizada) === 1) {
        socket.emit('chat_mensaje', { autor: null, texto: '🔥 ¡Casi! Estás muy cerca.', tipo: 'casi', hora: ahora });
      }
      return;
    }

    enviarMensaje(sala, { autor: jugador.nombre, texto, tipo: 'normal' });
  });

  // ---------------- Desconexión ----------------
  socket.on('disconnect', () => {
    const { codigo, jugadorId } = socket.data || {};
    if (!codigo) return;
    const sala = salas.get(codigo);
    if (!sala) return;
    const jugador = sala.jugadores.get(jugadorId);
    // Si el jugador ya se reconectó con otro socket, ignoramos este evento.
    if (!jugador || jugador.socketId !== socket.id) return;
    manejarDesconexion(sala, jugador);
  });
});

// --------------------------------------------------------------------------
//  Arranque
// --------------------------------------------------------------------------
servidor.listen(PUERTO, () => {
  console.log(`🎨 Pinturillo Clone escuchando en http://localhost:${PUERTO}`);
  console.log(`   Duración de cada turno: ${CONFIG.DURACION_TURNO} s`);
});
