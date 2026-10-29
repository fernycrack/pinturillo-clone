/**
 * ==========================================================================
 *  PINTURILLO CLONE · Lógica del cliente
 * ==========================================================================
 *  Este archivo lo usan las dos vistas:
 *   - index.html  (data-pagina="lobby")  -> crear / unirse a una sala.
 *   - room.html   (data-pagina="sala")   -> sala de juego completa.
 *
 *  Flujo de identidad:
 *   1. En el lobby se crea o verifica la sala y se guarda en sessionStorage
 *      { codigo, nombre, token }.
 *   2. room.html se conecta de nuevo (otra página = otro socket) y envía
 *      "unirse_sala". El token secreto permite reconectar al mismo jugador
 *      (por ejemplo al recargar la página) sin perder su puntaje ni su rol.
 *
 *  El dibujo viaja como "lotes" de segmentos con coordenadas normalizadas
 *  (0..1), por lo que cada pantalla puede tener un tamaño distinto.
 * ==========================================================================
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------------
  //  Constantes y utilidades compartidas
  // ------------------------------------------------------------------------
  const CLAVE_SESION = 'pinturillo_sesion';
  const CLAVE_ERROR = 'pinturillo_error';
  const ANCHO_LIENZO = 800;
  const ALTO_LIENZO = 600;

  const COLORES = [
    '#000000', '#6b7280', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6',
    '#3b82f6', '#8b5cf6', '#ec4899', '#92400e', '#fca5a5', '#86efac', '#93c5fd',
  ];

  const RAZONES_FIN_TURNO = {
    tiempo: '⌛ Se acabó el tiempo',
    todos: '🎉 ¡Todos adivinaron!',
    saltado: '⏭ El administrador saltó el turno',
    dibujante_desconectado: '🔌 El dibujante se desconectó',
  };

  const $ = (id) => document.getElementById(id);

  /** Crea un elemento. Usar textContent evita inyecciones de HTML desde el chat o los nombres. */
  function el(etiqueta, clases, texto) {
    const nodo = document.createElement(etiqueta);
    if (clases) nodo.className = clases;
    if (texto !== undefined && texto !== null) nodo.textContent = texto;
    return nodo;
  }

  function leerSesion() {
    try {
      return JSON.parse(sessionStorage.getItem(CLAVE_SESION));
    } catch (e) {
      return null;
    }
  }

  function guardarSesion(datos) {
    try {
      sessionStorage.setItem(CLAVE_SESION, JSON.stringify(datos));
    } catch (e) { /* almacenamiento no disponible: se ignora */ }
  }

  function borrarSesion() {
    try {
      sessionStorage.removeItem(CLAVE_SESION);
    } catch (e) { /* se ignora */ }
  }

  function guardarError(texto) {
    try {
      sessionStorage.setItem(CLAVE_ERROR, texto);
    } catch (e) { /* se ignora */ }
  }

  function tomarError() {
    try {
      const texto = sessionStorage.getItem(CLAVE_ERROR);
      sessionStorage.removeItem(CLAVE_ERROR);
      return texto;
    } catch (e) {
      return null;
    }
  }

  let temporizadorToast = null;
  function mostrarToast(texto, tipo = 'info') {
    const toast = $('toast');
    if (!toast) return;
    toast.textContent = texto;
    toast.className = 'toast toast-visible toast-' + tipo;
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => toast.classList.remove('toast-visible'), 3200);
  }

  function marcarConexion(conectado) {
    const pill = $('estadoConexion');
    if (!pill) return;
    pill.textContent = conectado ? '● Conectado' : '● Reconectando…';
    pill.className = 'pill ' + (conectado ? 'pill-conectado' : 'pill-desconectado');
  }

  function formatoTiempo(segundos) {
    const m = Math.floor(segundos / 60);
    const s = segundos % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function limitar(valor, min, max) {
    return Math.min(max, Math.max(min, valor));
  }

  /** Color estable para el avatar a partir del nombre. */
  function colorDeNombre(nombre) {
    let hash = 0;
    for (let i = 0; i < nombre.length; i++) hash = (hash * 31 + nombre.charCodeAt(i)) % 360;
    return `hsl(${hash} 65% 50%)`;
  }

  // ========================================================================
  //  VISTA 1 · LOBBY (index.html)
  // ========================================================================
  function iniciarLobby() {
    const socket = io();

    const btnModoCrear = $('btnModoCrear');
    const btnModoUnir = $('btnModoUnir');
    const formCrear = $('formCrear');
    const formUnir = $('formUnir');
    const textoElige = $('textoElige');
    const mensaje = $('mensajeLobby');

    function mostrarMensaje(texto) {
      mensaje.textContent = texto || '';
      mensaje.classList.toggle('hidden', !texto);
    }

    function bloquearFormularios(bloqueado) {
      $('btnEnviarCrear').disabled = bloqueado;
      $('btnEnviarUnir').disabled = bloqueado;
    }

    function mostrarModo(modo) {
      textoElige.classList.add('hidden');
      formCrear.classList.toggle('hidden', modo !== 'crear');
      formUnir.classList.toggle('hidden', modo !== 'unir');
      btnModoCrear.classList.toggle('activo', modo === 'crear');
      btnModoUnir.classList.toggle('activo', modo === 'unir');
      mostrarMensaje('');
      (modo === 'crear' ? $('nombreCrear') : $('nombreUnir')).focus();
    }

    btnModoCrear.addEventListener('click', () => mostrarModo('crear'));
    btnModoUnir.addEventListener('click', () => mostrarModo('unir'));

    // Los códigos siempre en mayúsculas y solo letras/números
    for (const campo of [$('codigoCrear'), $('codigoUnir')]) {
      campo.addEventListener('input', () => {
        campo.value = campo.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      });
    }

    socket.on('connect', () => marcarConexion(true));
    socket.on('disconnect', () => marcarConexion(false));

    // ---- Crear sala ----
    formCrear.addEventListener('submit', (e) => {
      e.preventDefault();
      const nombre = $('nombreCrear').value.trim();
      const codigo = $('codigoCrear').value.trim();
      if (!socket.connected) return mostrarMensaje('Sin conexión con el servidor. Inténtalo de nuevo en unos segundos.');

      bloquearFormularios(true);
      socket.emit('crear_sala', { nombre, codigo }, (res) => {
        bloquearFormularios(false);
        if (!res || !res.ok) return mostrarMensaje((res && res.error) || 'No se pudo crear la sala.');
        guardarSesion({ codigo: res.codigo, nombre, token: res.token });
        window.location.href = 'room.html?sala=' + encodeURIComponent(res.codigo);
      });
    });

    // ---- Unirse a sala ----
    formUnir.addEventListener('submit', (e) => {
      e.preventDefault();
      const nombre = $('nombreUnir').value.trim();
      const codigo = $('codigoUnir').value.trim().toUpperCase();
      if (!socket.connected) return mostrarMensaje('Sin conexión con el servidor. Inténtalo de nuevo en unos segundos.');

      bloquearFormularios(true);
      socket.emit('verificar_sala', { codigo, nombre }, (res) => {
        bloquearFormularios(false);
        if (!res || !res.ok) return mostrarMensaje((res && res.error) || 'No se pudo unir a la sala.');
        guardarSesion({ codigo: res.codigo, nombre, token: null });
        window.location.href = 'room.html?sala=' + encodeURIComponent(res.codigo);
      });
    });

    // ---- Enlace de invitación (?sala=ABCDE) o error devuelto desde la sala ----
    const codigoUrl = (new URLSearchParams(window.location.search).get('sala') || '').toUpperCase();
    if (codigoUrl) {
      $('codigoUnir').value = codigoUrl.replace(/[^A-Z0-9]/g, '').slice(0, 6);
      mostrarModo('unir');
    }
    const errorPrevio = tomarError();
    if (errorPrevio) mostrarMensaje(errorPrevio);
  }

  // ========================================================================
  //  VISTA 2 · SALA DE JUEGO (room.html)
  // ========================================================================
  function iniciarSala() {
    const codigoUrl = (new URLSearchParams(window.location.search).get('sala') || '').toUpperCase();
    const sesion = leerSesion();

    // Sin código, o sin sesión para esta sala (p. ej. abrieron un enlace compartido):
    // los mandamos al lobby para que elijan su nombre.
    if (!codigoUrl) {
      window.location.replace('index.html');
      return;
    }
    if (!sesion || sesion.codigo !== codigoUrl) {
      window.location.replace('index.html?sala=' + encodeURIComponent(codigoUrl));
      return;
    }

    const socket = io();

    // ---------------- Estado local ----------------
    const estado = {
      yoId: null,
      token: sesion.token || null,
      nombre: sesion.nombre,
      sala: null, // último "sala_estado" recibido
      turno: null, // datos del turno en curso
      turnoActivo: false,
      palabraSecreta: null, // solo la conoce el dibujante (y quien ya acertó)
      offsetReloj: 0, // diferencia entre el reloj del servidor y el local
    };

    let herramienta = 'lapiz'; // 'lapiz' | 'goma'
    let colorActual = COLORES[0];
    let grosorActual = 6;

    // Dibujo local
    let dibujando = false;
    let ultimoPunto = null;
    let loteActual = { color: colorActual, grosor: grosorActual, segs: [] };
    let temporizadorLote = null;

    // Panel admin
    let editandoId = null; // jugador cuyo nombre se está editando
    let intervaloPausa = null;

    // ---------------- Referencias al DOM ----------------
    const lienzo = $('lienzo');
    const ctx = lienzo.getContext('2d');
    const listaJugadores = $('listaJugadores');
    const chatMensajes = $('chatMensajes');
    const inputChat = $('inputChat');
    const txtPalabras = $('adminPalabras');

    $('codigoSala').textContent = codigoUrl;

    // ========================================================================
    //  Conexión y eventos del servidor
    // ========================================================================
    socket.on('connect', () => {
      marcarConexion(true);
      unirse();
    });

    socket.on('disconnect', () => marcarConexion(false));

    function unirse() {
      socket.emit(
        'unirse_sala',
        { codigo: codigoUrl, nombre: estado.nombre, token: estado.token },
        (res) => {
          if (!res || !res.ok) {
            // Sala inexistente, nombre repetido, sala llena… regresamos al lobby con el motivo.
            borrarSesion();
            guardarError((res && res.error) || 'No se pudo entrar a la sala.');
            window.location.replace('index.html?sala=' + encodeURIComponent(codigoUrl));
            return;
          }
          estado.yoId = res.id;
          estado.token = res.token;
          estado.nombre = res.nombre;
          guardarSesion({ codigo: codigoUrl, nombre: res.nombre, token: res.token });
          renderTodo();
        }
      );
    }

    socket.on('sala_estado', (s) => {
      estado.sala = s;
      if (s.fase !== 'jugando') estado.turnoActivo = false;
      renderTodo();
    });

    socket.on('admin_config', ({ palabras }) => {
      // No pisamos el texto si el admin está escribiendo en ese momento
      if (document.activeElement !== txtPalabras) txtPalabras.value = (palabras || []).join('\n');
      actualizarContadorPalabras();
    });

    socket.on('turno_inicio', (t) => {
      ocultarOverlayTurno();
      ocultarFinal();
      estado.turno = t;
      estado.turnoActivo = true;
      estado.palabraSecreta = null;
      estado.offsetReloj = t.ahora - Date.now();
      renderTodo();
    });

    // Solo llega al dibujante (y a quien ya adivinó)
    socket.on('turno_palabra', ({ palabra }) => {
      estado.palabraSecreta = palabra;
      renderBanner();
    });

    socket.on('turno_fin', (datos) => {
      estado.turnoActivo = false;
      terminarTrazoLocal();
      mostrarOverlayTurno(datos);
      renderTodo();
    });

    socket.on('juego_fin', ({ ranking }) => {
      estado.turnoActivo = false;
      terminarTrazoLocal();
      ocultarOverlayTurno();
      mostrarFinal(ranking);
      renderTodo();
    });

    socket.on('volver_lobby', () => {
      ocultarFinal();
      ocultarOverlayTurno();
      estado.turno = null;
      estado.turnoActivo = false;
      estado.palabraSecreta = null;
      limpiarLienzo();
      renderTodo();
    });

    socket.on('dibujo_segmentos', (lote) => dibujarLote(lote));
    socket.on('dibujo_limpiar', () => limpiarLienzo());
    socket.on('dibujo_historial', (historial) => {
      limpiarLienzo();
      (historial || []).forEach(dibujarLote);
    });

    socket.on('chat_mensaje', (m) => agregarMensaje(m));
    socket.on('chat_historial', (lista) => {
      chatMensajes.innerHTML = '';
      (lista || []).forEach(agregarMensaje);
    });

    socket.on('expulsado', ({ motivo }) => {
      borrarSesion();
      guardarError(motivo || 'Fuiste expulsado de la sala.');
      window.location.replace('index.html');
    });

    socket.on('sesion_reemplazada', () => {
      socket.disconnect();
      borrarSesion();
      guardarError('Tu sesión se abrió en otra pestaña.');
      window.location.replace('index.html');
    });

    // ========================================================================
    //  Ayudantes de rol
    // ========================================================================
    const soyAdmin = () => Boolean(estado.sala && estado.sala.adminId === estado.yoId);
    const soyDibujante = () =>
      Boolean(estado.turnoActivo && estado.turno && estado.turno.dibujanteId === estado.yoId);
    const yoAcerte = () => {
      if (!estado.sala) return false;
      const yo = estado.sala.jugadores.find((j) => j.id === estado.yoId);
      return Boolean(yo && yo.acerto);
    };

    // ========================================================================
    //  Render general
    // ========================================================================
    function renderTodo() {
      if (!estado.sala) return;
      renderEncabezado();
      renderJugadores();
      renderAdmin();
      renderBanner();
      renderHerramientas();
      renderVelo();
      renderChatEntrada();
      actualizarReloj();
    }

    function renderEncabezado() {
      const s = estado.sala;
      let texto = '';
      if (s.fase === 'lobby') {
        texto = `Sala de espera · ${s.jugadores.filter((j) => j.conectado).length} conectados`;
      } else if (s.fase === 'jugando' && estado.turno) {
        texto = `Palabra ${estado.turno.indice} de ${estado.turno.total} · dibuja ${estado.turno.dibujanteNombre}`;
      } else if (s.fase === 'entreturnos') {
        texto = `Palabra ${s.numeroTurno} de ${s.totalPalabras} · entre turnos`;
      } else if (s.fase === 'finalizada') {
        texto = 'Partida terminada';
      }
      $('infoTurno').textContent = texto;
    }

    // ---------------- Lista de jugadores / puntajes ----------------
    function renderJugadores() {
      const s = estado.sala;
      $('contadorJugadores').textContent = `${s.jugadores.length} jugador${s.jugadores.length === 1 ? '' : 'es'}`;
      listaJugadores.innerHTML = '';

      const orden = [...s.jugadores].sort(
        (a, b) => b.puntos - a.puntos || a.nombre.localeCompare(b.nombre, 'es')
      );

      orden.forEach((j, i) => {
        const esYo = j.id === estado.yoId;
        const dibuja = s.fase === 'jugando' && j.id === s.dibujanteActualId;

        let clases = 'fila-jugador';
        if (esYo) clases += ' fila-yo';
        if (!j.conectado) clases += ' fila-offline';
        if (dibuja) clases += ' fila-dibujando';
        if (j.acerto) clases += ' fila-acerto';
        const fila = el('li', clases);

        const avatar = el('span', 'avatar', j.nombre.charAt(0).toUpperCase());
        avatar.style.background = colorDeNombre(j.nombre);

        const info = el('div', 'min-w-0 flex-1');
        info.append(el('div', 'truncate text-sm font-semibold', j.nombre + (esYo ? ' (tú)' : '')));

        const insignias = [];
        if (j.id === s.adminId) insignias.push('👑 admin');
        if (dibuja) insignias.push('✏️ dibujando');
        if (j.acerto) insignias.push('✅ acertó');
        if (!j.conectado) insignias.push('desconectado');
        if (insignias.length) info.append(el('div', 'truncate text-xs text-slate-500', insignias.join(' · ')));

        fila.append(el('span', 'posicion', String(i + 1)), avatar, info, el('span', 'puntos', String(j.puntos)));
        listaJugadores.append(fila);
      });
    }

    // ---------------- Palabra secreta / máscara ----------------
    function renderBanner() {
      const s = estado.sala;
      if (!s) return;
      const etiqueta = $('bannerEtiqueta');
      const palabra = $('bannerPalabra');
      palabra.classList.remove('mascara', 'correcto');

      if (s.fase === 'jugando' && estado.turno && estado.turnoActivo) {
        if (soyDibujante()) {
          etiqueta.textContent = '✏️ Tu palabra para dibujar es';
          palabra.textContent = estado.palabraSecreta || '…';
        } else if (estado.palabraSecreta) {
          etiqueta.textContent = '✅ ¡Correcto! La palabra es';
          palabra.textContent = estado.palabraSecreta;
          palabra.classList.add('correcto');
        } else {
          etiqueta.textContent = `Adivina lo que dibuja ${estado.turno.dibujanteNombre} (${estado.turno.letras} letras)`;
          palabra.textContent = estado.turno.mascara;
          palabra.classList.add('mascara');
        }
      } else if (s.fase === 'entreturnos') {
        etiqueta.textContent = 'Entre turnos';
        palabra.textContent = '¡Prepárate!';
      } else if (s.fase === 'finalizada') {
        etiqueta.textContent = 'Partida terminada';
        palabra.textContent = '🏁 Fin';
      } else {
        etiqueta.textContent = 'Sala de espera';
        palabra.textContent = 'Esperando…';
      }
    }

    function renderHerramientas() {
      const visible = soyDibujante();
      $('herramientas').classList.toggle('hidden', !visible);
      $('herramientas').classList.toggle('flex', visible);
      lienzo.classList.toggle('lienzo-dibujable', visible);
    }

    function renderVelo() {
      const s = estado.sala;
      const velo = $('velo');
      if (s.fase === 'lobby') {
        velo.classList.remove('hidden');
        $('veloTitulo').textContent = '🎨 Sala de espera';
        $('veloTexto').textContent = soyAdmin()
          ? 'Comparte el código de la sala, agrega las palabras secretas, elige a los dibujantes y pulsa «Iniciar partida».'
          : 'Esperando a que el administrador inicie la partida…';
      } else {
        velo.classList.add('hidden');
      }
    }

    function renderChatEntrada() {
      const bloqueado = soyDibujante();
      inputChat.disabled = bloqueado;
      if (bloqueado) {
        inputChat.placeholder = 'Eres el dibujante: ¡dibuja!';
      } else if (estado.turnoActivo && yoAcerte()) {
        inputChat.placeholder = 'Ya acertaste. Solo lo ven quienes acertaron.';
      } else if (estado.turnoActivo) {
        inputChat.placeholder = 'Escribe tu respuesta…';
      } else {
        inputChat.placeholder = 'Escribe un mensaje…';
      }
    }

    // ========================================================================
    //  Cronómetro (sincronizado con el reloj del servidor)
    // ========================================================================
    function actualizarReloj() {
      const contador = $('contadorTiempo');
      const barra = $('barraTiempo');
      const reloj = $('reloj');

      if (estado.turnoActivo && estado.turno) {
        const restanteMs = estado.turno.finaliza - (Date.now() + estado.offsetReloj);
        const segundos = Math.max(0, Math.ceil(restanteMs / 1000));
        const porcentaje = limitar((restanteMs / (estado.turno.duracion * 1000)) * 100, 0, 100);

        contador.textContent = formatoTiempo(segundos);
        barra.style.width = porcentaje + '%';
        barra.classList.toggle('medio', porcentaje <= 50 && porcentaje > 20);
        barra.classList.toggle('poco', porcentaje <= 20);
        reloj.classList.toggle('reloj-urgente', segundos <= 20 && segundos > 0);
      } else {
        contador.textContent = '--:--';
        barra.style.width = '0%';
        reloj.classList.remove('reloj-urgente');
      }
    }
    setInterval(actualizarReloj, 250);

    // ========================================================================
    //  Panel del administrador
    // ========================================================================
    function renderAdmin() {
      const s = estado.sala;
      const admin = soyAdmin();
      $('panelAdmin').classList.toggle('hidden', !admin);
      if (!admin) return;

      const enLobby = s.fase === 'lobby';
      $('seccionPalabras').classList.toggle('hidden', !enLobby);
      $('btnIniciar').classList.toggle('hidden', !enLobby);
      $('btnSaltar').classList.toggle('hidden', s.fase !== 'jugando');
      $('btnTerminar').classList.toggle('hidden', !(s.fase === 'jugando' || s.fase === 'entreturnos'));
      $('btnNueva').classList.toggle('hidden', s.fase !== 'finalizada');

      // Mientras se edita un nombre no reconstruimos la lista (se perdería el foco).
      if (editandoId) return;
      renderAdminJugadores();
    }

    function renderAdminJugadores() {
      const s = estado.sala;
      const cont = $('adminJugadores');
      cont.innerHTML = '';

      s.jugadores.forEach((j) => {
        const fila = el('div', 'admin-fila');

        // Casilla "será dibujante"
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = s.dibujantes.includes(j.id);
        chk.title = 'Marcar como dibujante';
        chk.addEventListener('change', () => alternarDibujante(j.id, chk.checked));
        fila.append(chk);

        const orden = s.dibujantes.indexOf(j.id);
        if (orden >= 0) fila.append(el('span', 'admin-orden', `✏️${orden + 1}`));

        if (editandoId === j.id) {
          // Modo edición del nombre
          const input = document.createElement('input');
          input.type = 'text';
          input.maxLength = 20;
          input.value = j.nombre;
          input.className = 'campo min-w-0 flex-1 !py-0.5 !text-sm';
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') guardarNombre(j.id, input.value);
            if (e.key === 'Escape') cancelarEdicion();
          });
          fila.append(input);

          const ok = el('button', 'icono-boton', '✔');
          ok.type = 'button';
          ok.title = 'Guardar nombre';
          ok.addEventListener('click', () => guardarNombre(j.id, input.value));
          const cancelar = el('button', 'icono-boton', '✖');
          cancelar.type = 'button';
          cancelar.title = 'Cancelar';
          cancelar.addEventListener('click', cancelarEdicion);
          fila.append(ok, cancelar);

          // Enfocamos el campo al terminar de construir la lista
          setTimeout(() => {
            input.focus();
            input.select();
          }, 0);
        } else {
          const nombre = el(
            'span',
            'min-w-0 flex-1 truncate' + (j.conectado ? '' : ' text-slate-400'),
            j.nombre + (j.id === estado.yoId ? ' (tú)' : '')
          );
          fila.append(nombre);

          const renombrar = el('button', 'icono-boton', '✎');
          renombrar.type = 'button';
          renombrar.title = 'Renombrar jugador';
          renombrar.addEventListener('click', () => {
            editandoId = j.id;
            renderAdminJugadores();
          });
          fila.append(renombrar);

          if (j.id !== estado.yoId) {
            const expulsar = el('button', 'icono-boton', '🚫');
            expulsar.type = 'button';
            expulsar.title = 'Expulsar de la sala';
            expulsar.addEventListener('click', () => {
              if (window.confirm(`¿Expulsar a ${j.nombre} de la sala?`)) {
                socket.emit('admin_expulsar', { id: j.id }, (res) => {
                  if (res && !res.ok) mostrarToast(res.error, 'error');
                });
              }
            });
            fila.append(expulsar);
          }
        }
        cont.append(fila);
      });
    }

    function alternarDibujante(id, marcado) {
      const actual = estado.sala.dibujantes.slice();
      const indice = actual.indexOf(id);
      if (marcado && indice < 0) actual.push(id);
      if (!marcado && indice >= 0) actual.splice(indice, 1);
      socket.emit('admin_dibujantes', { ids: actual });
    }

    function guardarNombre(id, nombre) {
      socket.emit('admin_renombrar', { id, nombre }, (res) => {
        if (!res || !res.ok) {
          mostrarToast((res && res.error) || 'No se pudo renombrar.', 'error');
          return;
        }
        editandoId = null;
        renderAdminJugadores();
      });
    }

    function cancelarEdicion() {
      editandoId = null;
      renderAdminJugadores();
    }

    function leerPalabras() {
      return txtPalabras.value
        .split(/\r?\n|,/)
        .map((p) => p.trim())
        .filter(Boolean);
    }

    function actualizarContadorPalabras() {
      $('adminContador').textContent = String(leerPalabras().length);
    }

    function mostrarMensajeAdmin(texto) {
      const caja = $('adminMensaje');
      caja.textContent = texto || '';
      caja.classList.toggle('hidden', !texto);
    }

    txtPalabras.addEventListener('input', actualizarContadorPalabras);

    $('btnGuardarPalabras').addEventListener('click', () => {
      socket.emit('admin_palabras', { palabras: leerPalabras() }, (res) => {
        if (!res || !res.ok) return mostrarMensajeAdmin((res && res.error) || 'No se pudieron guardar las palabras.');
        mostrarMensajeAdmin('');
        txtPalabras.value = res.palabras.join('\n');
        actualizarContadorPalabras();
        mostrarToast(`${res.cantidad} palabra${res.cantidad === 1 ? '' : 's'} guardada${res.cantidad === 1 ? '' : 's'}`, 'ok');
      });
    });

    $('btnIniciar').addEventListener('click', () => {
      // Guardamos las palabras primero para que nunca se olvide hacerlo.
      socket.emit('admin_palabras', { palabras: leerPalabras() }, (r1) => {
        if (!r1 || !r1.ok) return mostrarMensajeAdmin((r1 && r1.error) || 'No se pudieron guardar las palabras.');
        txtPalabras.value = r1.palabras.join('\n');
        actualizarContadorPalabras();
        socket.emit('admin_iniciar', {}, (r2) => {
          mostrarMensajeAdmin(r2 && r2.ok ? '' : (r2 && r2.error) || 'No se pudo iniciar la partida.');
        });
      });
    });

    $('btnSaltar').addEventListener('click', () => socket.emit('admin_saltar_turno', {}));

    $('btnTerminar').addEventListener('click', () => {
      if (window.confirm('¿Terminar la partida ahora y mostrar los resultados?')) {
        socket.emit('admin_terminar', {});
      }
    });

    $('btnNueva').addEventListener('click', () => socket.emit('admin_nueva_partida', {}));
    $('btnNuevaFinal').addEventListener('click', () => socket.emit('admin_nueva_partida', {}));

    // ========================================================================
    //  Chat
    // ========================================================================
    $('formChat').addEventListener('submit', (e) => {
      e.preventDefault();
      const texto = inputChat.value.trim();
      if (!texto) return;
      socket.emit('chat_mensaje', { texto });
      inputChat.value = '';
    });

    function agregarMensaje(m) {
      const cercaDelFinal =
        chatMensajes.scrollHeight - chatMensajes.scrollTop - chatMensajes.clientHeight < 80;

      const div = el('div', `msg msg-${m.tipo}`);
      if (m.tipo === 'normal' || m.tipo === 'privado') {
        if (m.tipo === 'privado') div.append(el('span', null, '🔒 '));
        div.append(el('strong', null, `${m.autor}: `), document.createTextNode(m.texto));
      } else {
        div.textContent = m.texto;
      }
      chatMensajes.append(div);

      while (chatMensajes.children.length > 200) chatMensajes.removeChild(chatMensajes.firstChild);
      if (cercaDelFinal) chatMensajes.scrollTop = chatMensajes.scrollHeight;
    }

    // ========================================================================
    //  Canvas de dibujo
    // ========================================================================
    function limpiarLienzo() {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ANCHO_LIENZO, ALTO_LIENZO);
    }

    /** Dibuja un segmento con coordenadas normalizadas (0..1). */
    function dibujarSegmento(x0, y0, x1, y1, color, grosor) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = grosor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (x0 === x1 && y0 === y1) {
        // Un simple clic: dibujamos un punto
        ctx.beginPath();
        ctx.arc(x1 * ANCHO_LIENZO, y1 * ALTO_LIENZO, grosor / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(x0 * ANCHO_LIENZO, y0 * ALTO_LIENZO);
      ctx.lineTo(x1 * ANCHO_LIENZO, y1 * ALTO_LIENZO);
      ctx.stroke();
    }

    function dibujarLote(lote) {
      if (!lote || !Array.isArray(lote.segs)) return;
      for (const s of lote.segs) dibujarSegmento(s[0], s[1], s[2], s[3], lote.color, lote.grosor);
    }

    /** Convierte la posición del puntero a coordenadas normalizadas. */
    function posicionPuntero(evento) {
      const caja = lienzo.getBoundingClientRect();
      return {
        x: Math.round(limitar((evento.clientX - caja.left) / caja.width, 0, 1) * 10000) / 10000,
        y: Math.round(limitar((evento.clientY - caja.top) / caja.height, 0, 1) * 10000) / 10000,
      };
    }

    function propiedadesTrazo() {
      // La goma pinta de blanco (color del fondo) y es más gruesa que el lápiz
      return herramienta === 'goma'
        ? { color: '#ffffff', grosor: Math.min(100, grosorActual * 2) }
        : { color: colorActual, grosor: grosorActual };
    }

    function agregarSegmento(a, b) {
      const { color, grosor } = propiedadesTrazo();

      // Si cambió el color o el grosor, enviamos primero lo acumulado
      if (loteActual.segs.length && (loteActual.color !== color || loteActual.grosor !== grosor)) {
        enviarLote();
      }
      loteActual.color = color;
      loteActual.grosor = grosor;
      loteActual.segs.push([a.x, a.y, b.x, b.y]);

      dibujarSegmento(a.x, a.y, b.x, b.y, color, grosor); // dibujo local inmediato

      // Agrupamos segmentos ~30 ms para no saturar la red
      if (!temporizadorLote) temporizadorLote = setTimeout(enviarLote, 30);
    }

    function enviarLote() {
      clearTimeout(temporizadorLote);
      temporizadorLote = null;
      if (!loteActual.segs.length) return;
      socket.emit('dibujo_segmentos', {
        color: loteActual.color,
        grosor: loteActual.grosor,
        segs: loteActual.segs,
      });
      loteActual = { color: loteActual.color, grosor: loteActual.grosor, segs: [] };
    }

    function terminarTrazoLocal() {
      dibujando = false;
      ultimoPunto = null;
      enviarLote();
    }

    lienzo.addEventListener('pointerdown', (e) => {
      if (!soyDibujante()) return;
      e.preventDefault();
      try {
        lienzo.setPointerCapture(e.pointerId);
      } catch (err) { /* algunos navegadores no lo soportan: se ignora */ }
      dibujando = true;
      ultimoPunto = posicionPuntero(e);
      agregarSegmento(ultimoPunto, ultimoPunto);
    });

    lienzo.addEventListener('pointermove', (e) => {
      if (!dibujando || !soyDibujante()) return;
      e.preventDefault();
      const punto = posicionPuntero(e);
      agregarSegmento(ultimoPunto, punto);
      ultimoPunto = punto;
    });

    for (const tipo of ['pointerup', 'pointercancel']) {
      lienzo.addEventListener(tipo, () => {
        if (dibujando) terminarTrazoLocal();
      });
    }

    // ---- Barra de herramientas ----
    function seleccionarHerramienta(nueva) {
      herramienta = nueva;
      $('btnLapiz').classList.toggle('herramienta-activa', nueva === 'lapiz');
      $('btnGoma').classList.toggle('herramienta-activa', nueva === 'goma');
    }

    function marcarColorSeleccionado() {
      document.querySelectorAll('#paletaColores .muestra-color').forEach((boton) => {
        boton.classList.toggle('seleccionada', boton.dataset.color === colorActual);
      });
    }

    COLORES.forEach((color) => {
      const boton = el('button', 'muestra-color');
      boton.type = 'button';
      boton.style.background = color;
      boton.dataset.color = color;
      boton.title = color;
      boton.addEventListener('click', () => {
        colorActual = color;
        $('colorPersonalizado').value = color;
        seleccionarHerramienta('lapiz');
        marcarColorSeleccionado();
      });
      $('paletaColores').append(boton);
    });
    marcarColorSeleccionado();

    $('colorPersonalizado').addEventListener('input', (e) => {
      colorActual = e.target.value;
      seleccionarHerramienta('lapiz');
      marcarColorSeleccionado();
    });

    $('grosor').addEventListener('input', (e) => {
      grosorActual = Number(e.target.value);
      $('valorGrosor').textContent = `${grosorActual} px`;
    });

    $('btnLapiz').addEventListener('click', () => seleccionarHerramienta('lapiz'));
    $('btnGoma').addEventListener('click', () => seleccionarHerramienta('goma'));
    $('btnLimpiar').addEventListener('click', () => {
      if (!soyDibujante()) return;
      terminarTrazoLocal();
      limpiarLienzo();
      socket.emit('dibujo_limpiar');
    });

    // ========================================================================
    //  Overlays: fin de turno y resultados finales
    // ========================================================================
    function mostrarOverlayTurno(datos) {
      $('turnoPalabra').textContent = datos.palabra;
      $('turnoRazon').textContent = RAZONES_FIN_TURNO[datos.razon] || 'Fin del turno';

      const lista = $('turnoGanancias');
      lista.innerHTML = '';
      if (!datos.ganancias.length) {
        lista.append(el('li', 'text-center text-slate-500', 'Nadie adivinó esta vez 😅'));
      } else {
        datos.ganancias.forEach((g) => {
          const fila = el('li', 'ganancia' + (g.esDibujante ? ' dibujante' : ''));
          fila.append(
            el('span', null, g.nombre + (g.esDibujante ? ' (bonus de dibujante)' : '')),
            el('span', 'text-emerald-700', `+${g.puntos}`)
          );
          lista.append(fila);
        });
      }

      let restante = Math.round(datos.siguienteEn);
      $('turnoCuenta').textContent = String(restante);
      clearInterval(intervaloPausa);
      intervaloPausa = setInterval(() => {
        restante -= 1;
        $('turnoCuenta').textContent = String(Math.max(0, restante));
        if (restante <= 0) clearInterval(intervaloPausa);
      }, 1000);

      $('overlayTurno').classList.remove('hidden');
    }

    function ocultarOverlayTurno() {
      clearInterval(intervaloPausa);
      $('overlayTurno').classList.add('hidden');
    }

    function mostrarFinal(ranking) {
      // ---- Podio: orden visual 2.º · 1.º · 3.º ----
      const podio = $('podio');
      podio.innerHTML = '';
      const medallas = ['🥇', '🥈', '🥉'];
      const ordenVisual = [1, 0, 2];
      ordenVisual.forEach((indice) => {
        const jugador = ranking[indice];
        if (!jugador) return;
        const columna = el('div', 'podio-columna');
        columna.append(
          el('div', 'podio-medalla', medallas[indice]),
          el('div', 'podio-nombre', jugador.nombre),
          el('div', 'podio-puntos', `${jugador.puntos} pts`),
          el('div', `podio-bloque podio-${indice + 1}`)
        );
        podio.append(columna);
      });

      // ---- Tabla completa ----
      const tabla = $('tablaFinal');
      tabla.innerHTML = '';
      ranking.forEach((j) => {
        const fila = el('tr', 'border-t border-slate-200' + (j.id === estado.yoId ? ' fila-tabla-yo' : ''));
        fila.append(
          el('td', 'px-3 py-2', String(j.posicion)),
          el('td', 'px-3 py-2', j.nombre + (j.id === estado.yoId ? ' (tú)' : '')),
          el('td', 'px-3 py-2 text-right tabular-nums', String(j.puntos))
        );
        tabla.append(fila);
      });

      const admin = soyAdmin();
      $('btnNuevaFinal').classList.toggle('hidden', !admin);
      $('textoEsperaFinal').classList.toggle('hidden', admin);
      $('overlayFinal').classList.remove('hidden');
    }

    function ocultarFinal() {
      $('overlayFinal').classList.add('hidden');
    }

    // Si cambia el admin mientras se ve el podio, actualizamos los botones
    function refrescarBotonesFinal() {
      if ($('overlayFinal').classList.contains('hidden')) return;
      const admin = soyAdmin();
      $('btnNuevaFinal').classList.toggle('hidden', !admin);
      $('textoEsperaFinal').classList.toggle('hidden', admin);
    }
    socket.on('sala_estado', refrescarBotonesFinal);

    // ========================================================================
    //  Cabecera: copiar enlace y salir
    // ========================================================================
    $('btnCopiar').addEventListener('click', async () => {
      const enlace = `${window.location.origin}/room.html?sala=${encodeURIComponent(codigoUrl)}`;
      try {
        await navigator.clipboard.writeText(enlace);
        mostrarToast('Enlace de invitación copiado 📋', 'ok');
      } catch (err) {
        window.prompt('Copia este enlace para invitar a tus amigos:', enlace);
      }
    });

    function salirDeLaSala() {
      socket.emit('salir_sala');
      borrarSesion();
      window.location.href = 'index.html';
    }
    $('btnSalir').addEventListener('click', () => {
      if (window.confirm('¿Seguro que quieres salir de la sala?')) salirDeLaSala();
    });
    $('btnSalirFinal').addEventListener('click', salirDeLaSala);

    // Estado inicial del lienzo
    limpiarLienzo();
  }

  // ------------------------------------------------------------------------
  //  Arranque: cada página declara cuál es con data-pagina
  // ------------------------------------------------------------------------
  const pagina = document.body.dataset.pagina;
  if (pagina === 'lobby') iniciarLobby();
  else if (pagina === 'sala') iniciarSala();
})();
