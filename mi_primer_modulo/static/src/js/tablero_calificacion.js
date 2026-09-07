import { Component, onWillStart, onWillUnmount, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardActionServiceProps } from "@web/webclient/actions/action_service";
import { PanelCalificacion } from "./panel_calificacion";

// Mismo orden de progresión que la Selection de cinta_actual/cinta_evaluada
// en Python. Lo usamos para que "ordenar por Cinta" siga el avance real de
// las cintas y no el orden alfabético (que mezclaría amarilla antes que azul
// antes que blanca, sin sentido para una academia de taekwondo).
const ORDEN_CINTAS = [
    "blanca", "naranja", "naranja_avanzada", "amarilla", "amarilla_avanzada",
    "verde", "verde_avanzada", "azul", "azul_avanzada", "roja", "roja_avanzada", "negra",
];
const RANGO_CINTA = Object.fromEntries(ORDEN_CINTAS.map((cinta, indice) => [cinta, indice]));

// resultado ya viene en español desde el modelo (aprobado/reprobado/pendiente),
// así que basta un mapeo fijo de despliegue - a diferencia de cinta_evaluada,
// aquí no hace falta pedirle la Selection al servidor vía fields_get.
const RESULTADO_LABELS = {
    aprobado: "Aprobado",
    reprobado: "Reprobado",
    pendiente: "Pendiente",
};

// Geometría de la "mesa": un lienzo de posición libre donde el sinodal
// arrastra las tarjetas para reproducir la distribución física real de los
// alumnos durante el examen. Es una vista PERSONAL: no se sincroniza entre
// distintos sinodales/dispositivos.
const ANCHO_TARJETA = 360;
// Ancho de una tarjeta con el panel de calificación abierto inline. Arranca
// en 1.75x (≈630px); si los 4 bloques de criterio se ven apretados se sube
// a 2x cambiando solo el multiplicador.
const ANCHO_TARJETA_ABIERTA = Math.round(ANCHO_TARJETA * 1.75);
const ALTO_TARJETA = 140;          // huella aproximada de una tarjeta colapsada
// Estimado FIJO del alto de una tarjeta abierta. NO se mide el DOM con
// getBoundingClientRect: PanelCalificacion carga async y mediríamos el
// placeholder "Cargando examen…", no el contenido final.
const ALTO_TARJETA_ABIERTA = 720;
const ANCHO_LIENZO = 1400;
const ANCHO_LIENZO_MAX = 4000;
const ALTO_LIENZO_MAX = 3000;
const SEPARACION = 16;
const HOLGURA_ENCIMADO = 40;       // px de traslape tolerado antes de considerar "encimadas"

export class TableroCalificacion extends Component {
    static template = "mi_primer_modulo.TableroCalificacion";
    static components = { PanelCalificacion };
    static props = {
        ...standardActionServiceProps,
    };

    setup() {
        this.orm = useService("orm");
        this.lienzoRef = useRef("lienzo");

        this.state = useState({
            cargando: true,
            roster: [],
            ordenPor: "edad",
            rosterColapsado: false,
            // 'mesa': exámenes en la mesa. 'posiciones': {examenId: {x, y}} en
            // px dentro del lienzo = posición CANÓNICA, la que persiste en
            // posicion_x/posicion_y y que SOLO cambia el drag-and-drop.
            // 'posicionesTemporales': {examenId: {x, y}} desplazamiento SOLO
            // visual de las vecinas que una tarjeta abierta empuja; nunca se
            // persiste y se limpia en cuanto deja de haber conflicto.
            // 'tarjetasAbiertas': cuáles muestran el panel completo inline.
            // 'expandido': tarjeta a pantalla completa, o null.
            // 'arrastrando': examenId que se está arrastrando (para el z-index).
            mesa: [],
            posiciones: {},
            posicionesTemporales: {},
            tarjetasAbiertas: [],
            expandido: null,
            arrastrando: null,
            progreso: {},
        });

        // Estado vivo del arrastre en curso + listeners globales estables.
        this._arrastre = null;
        this._onMove = (ev) => this._alMover(ev);
        this._onUp = (ev) => this._alSoltar(ev);

        onWillStart(async () => {
            const eventoId = this.props.action.params.evento_id;

            const examenes = await this.orm.searchRead(
                "taekwondo.examen",
                [["evento_id", "=", eventoId]],
                [
                    "alumno_id", "cinta_evaluada", "resultado", "mejor_examen",
                    "posicion_x", "posicion_y",
                ]
            );

            const alumnoIds = [...new Set(examenes.map((examen) => examen.alumno_id[0]))];

            // UNA sola llamada trae los datos de TODOS los alumnos del
            // roster juntos, en vez de un viaje al servidor por cada uno.
            const alumnos = await this.orm.read(
                "taekwondo.alumno",
                alumnoIds,
                ["name", "foto", "edad"]
            );
            const alumnosPorId = Object.fromEntries(
                alumnos.map((alumno) => [alumno.id, alumno])
            );

            // orm.read/searchRead traen el valor CRUDO de un campo Selection
            // (la clave técnica, ej. "verde_avanzada"), no la etiqueta
            // traducida - esa traducción normalmente la hace el widget de
            // las vistas estándar de Odoo, usando la metadata del campo que
            // trae fields_get. Como aquí no hay vista ni widget, la pedimos
            // nosotros mismos, UNA sola vez (no por cada examen).
            const camposExamen = await this.orm.call("taekwondo.examen", "fields_get", [], {
                allfields: ["cinta_evaluada"],
                attributes: ["selection"],
            });
            const cintaLabels = Object.fromEntries(camposExamen.cinta_evaluada.selection);

            this.state.roster = examenes.map((examen) => {
                const alumno = alumnosPorId[examen.alumno_id[0]];
                return {
                    examenId: examen.id,
                    name: alumno.name,
                    foto: alumno.foto,
                    edad: alumno.edad,
                    // Guardamos AMBOS: el valor crudo (cintaEvaluada) sigue
                    // siendo necesario para ordenar con RANGO_CINTA, y la
                    // etiqueta (cintaEvaluadaLabel) es la que se muestra.
                    cintaEvaluada: examen.cinta_evaluada,
                    cintaEvaluadaLabel: cintaLabels[examen.cinta_evaluada] || examen.cinta_evaluada,
                    resultado: examen.resultado,
                    mejorExamen: examen.mejor_examen,
                };
            });

            // Otra llamada batch (no una por examen): trae de un solo golpe
            // los criterios de TODOS los exámenes del evento, y con eso
            // contamos cuántos ya tienen calificación por examen.
            const criteriosTodos = await this.orm.searchRead(
                "taekwondo.criterio_calificacion",
                [["examen_id", "in", examenes.map((examen) => examen.id)]],
                ["examen_id", "calificacion"]
            );
            const progreso = Object.fromEntries(examenes.map((examen) => [examen.id, 0]));
            for (const criterio of criteriosTodos) {
                if (criterio.calificacion) {
                    progreso[criterio.examen_id[0]] += 1;
                }
            }
            this.state.progreso = progreso;

            // Restaurar la mesa personal: todo examen con posición guardada
            // (x o y != 0) vuelve a la mesa, colapsado, donde se dejó.
            const mesa = [];
            const posiciones = {};
            for (const examen of examenes) {
                if (examen.posicion_x || examen.posicion_y) {
                    mesa.push(examen.id);
                    posiciones[examen.id] = { x: examen.posicion_x, y: examen.posicion_y };
                }
            }
            this.state.mesa = mesa;
            this.state.posiciones = posiciones;
            this._corregirEncimados();

            this.state.cargando = false;
        });

        onWillUnmount(() => this._quitarListenersGlobales());
    }

    // ---- roster / orden --------------------------------------------------

    get rosterOrdenado() {
        // Copiamos el arreglo antes de ordenar: sort() ordena "en el lugar",
        // y modificar el estado reactivo directamente desde un getter que
        // se llama en cada render es una mala práctica (podría disparar
        // renders extra o dejar el orden inconsistente entre pantallas).
        const roster = [...this.state.roster];
        if (this.state.ordenPor === "edad") {
            roster.sort((a, b) => a.edad - b.edad);
        } else {
            roster.sort((a, b) => RANGO_CINTA[a.cintaEvaluada] - RANGO_CINTA[b.cintaEvaluada]);
        }
        return roster;
    }

    get rosterPorExamenId() {
        return Object.fromEntries(this.state.roster.map((item) => [item.examenId, item]));
    }

    ordenarPor(criterio) {
        this.state.ordenPor = criterio;
    }

    alternarRoster() {
        this.state.rosterColapsado = !this.state.rosterColapsado;
    }

    // ---- mesa: agregar / quitar / abrir / expandir ---------------------

    agregarAMesa(examenId) {
        if (this.state.mesa.includes(examenId)) {
            return;
        }
        // Si ya tenía posición (el sinodal lo había acomodado y luego lo
        // quitó), se respeta y reaparece ahí. Solo si nunca tuvo posición
        // se le asigna un hueco automático.
        if (!this.state.posiciones[examenId]) {
            this.state.posiciones[examenId] = this._siguienteSlot();
        }
        this.state.mesa.push(examenId);
        this._reconciliarVecinas();
    }

    quitarDeMesa(examenId) {
        // "Quitar" es PURAMENTE VISUAL: solo saca el examenId del arreglo
        // 'mesa'. NO se borra 'state.posiciones[examenId]' ni se toca
        // posicion_x/posicion_y en el servidor, para que al volver a agregar
        // al alumno con "+" reaparezca exactamente donde el sinodal lo dejó.
        this.state.mesa = this.state.mesa.filter((id) => id !== examenId);
        this.state.tarjetasAbiertas = this.state.tarjetasAbiertas.filter((id) => id !== examenId);
        if (this.state.expandido === examenId) {
            this.state.expandido = null;
        }
        this._soltarTemporal(examenId);
        this._reconciliarVecinas();
    }

    estaAbierta(examenId) {
        return this.state.tarjetasAbiertas.includes(examenId);
    }

    alternarTarjeta(examenId) {
        if (this.state.tarjetasAbiertas.includes(examenId)) {
            this.state.tarjetasAbiertas = this.state.tarjetasAbiertas.filter((id) => id !== examenId);
        } else {
            this.state.tarjetasAbiertas.push(examenId);
            // La tarjeta que se abre es con la que el sinodal va a trabajar:
            // se queda en SU posición guardada (deja de estar desplazada por
            // otra) y son las vecinas las que se reacomodan alrededor.
            this._soltarTemporal(examenId);
        }
        this._reconciliarVecinas();
    }

    expandir(examenId) {
        this.state.expandido = examenId;
    }

    regresar() {
        this.state.expandido = null;
    }

    etiquetaResultado(valor) {
        return RESULTADO_LABELS[valor] || valor;
    }

    // ---- geometría del lienzo -----------------------------------------

    get altoLienzo() {
        // Considera el alto REAL de cada tarjeta (abierta o no) y su posición
        // EFECTIVA (incluye el desplazamiento temporal de las vecinas
        // empujadas), para que el lienzo nunca recorte contenido.
        let maxAbajo = 700;
        for (const id of this.state.mesa) {
            const alto = this.estaAbierta(id) ? ALTO_TARJETA_ABIERTA : ALTO_TARJETA;
            maxAbajo = Math.max(maxAbajo, this._posEfectiva(id).y + alto);
        }
        return Math.min(maxAbajo + 80, ALTO_LIENZO_MAX);
    }

    get anchoLienzo() {
        // El lienzo nunca se encoge de ANCHO_LIENZO. Pero SÍ crece si una
        // tarjeta abierta (o una vecina empujada) sobresale por la derecha:
        // así el overflow-x del contenedor la deja alcanzable con scroll, sin
        // moverla ni limitarla (requisito de la tarjeta abierta).
        let maxDerecha = ANCHO_LIENZO;
        for (const id of this.state.mesa) {
            const ancho = this.estaAbierta(id) ? ANCHO_TARJETA_ABIERTA : ANCHO_TARJETA;
            maxDerecha = Math.max(maxDerecha, this._posEfectiva(id).x + ancho + 80);
        }
        return Math.min(maxDerecha, ANCHO_LIENZO_MAX);
    }

    posicionTarjeta(examenId) {
        const p = this._posEfectiva(examenId);
        const ancho = this.estaAbierta(examenId) ? ANCHO_TARJETA_ABIERTA : ANCHO_TARJETA;
        let z = 10;
        if (this.state.arrastrando === examenId) {
            z = 30;
        } else if (this.estaAbierta(examenId)) {
            z = 20;
        }
        // La tarjeta que se arrastra sigue al puntero sin transición (si no,
        // "flota" con retraso). Las demás animan left/top/width para que se
        // vea el reacomodo automático de las vecinas.
        const transicion = this.state.arrastrando === examenId
            ? "none"
            : "left .15s ease, top .15s ease, width .15s ease";
        return `left:${p.x}px; top:${p.y}px; width:${ancho}px; z-index:${z}; transition:${transicion};`;
    }

    // -- helpers de geometría (rectángulos de ancho/alto variable) --------

    _dimsDe(examenId) {
        return this.estaAbierta(examenId)
            ? { w: ANCHO_TARJETA_ABIERTA, h: ALTO_TARJETA_ABIERTA }
            : { w: ANCHO_TARJETA, h: ALTO_TARJETA };
    }

    _posGuardada(examenId) {
        return this.state.posiciones[examenId] || { x: 0, y: 0 };
    }

    // Dónde se DIBUJA la tarjeta: su desplazamiento temporal si una vecina
    // abierta la está empujando, si no su posición guardada.
    _posEfectiva(examenId) {
        return this.state.posicionesTemporales[examenId] || this._posGuardada(examenId);
    }

    _rect(pos, dims) {
        return { x: pos.x, y: pos.y, w: dims.w, h: dims.h };
    }

    _solapeEje(a0, a1, b0, b1) {
        return Math.min(a1, b1) - Math.max(a0, b0);
    }

    // Dos rectángulos "chocan" si se traslapan en AMBOS ejes por más de
    // HOLGURA_ENCIMADO px. Vale para tarjetas de cualquier tamaño (una
    // abierta es más ancha y más alta que una colapsada).
    _seSolapan(a, b) {
        return (
            this._solapeEje(a.x, a.x + a.w, b.x, b.x + b.w) > HOLGURA_ENCIMADO &&
            this._solapeEje(a.y, a.y + a.h, b.y, b.y + b.h) > HOLGURA_ENCIMADO
        );
    }

    _soltarTemporal(examenId) {
        if (this.state.posicionesTemporales[examenId]) {
            const { [examenId]: _omit, ...resto } = this.state.posicionesTemporales;
            this.state.posicionesTemporales = resto;
        }
    }

    _limitar(x, y) {
        const maxX = Math.max(0, ANCHO_LIENZO - ANCHO_TARJETA);
        const maxY = Math.max(0, this.altoLienzo - ALTO_TARJETA);
        return [Math.max(0, Math.min(x, maxX)), Math.max(0, Math.min(y, maxY))];
    }

    _siguienteSlot() {
        const colocadas = this.state.mesa
            .filter((id) => this.state.posiciones[id])
            .map((id) => this._rect(this._posEfectiva(id), this._dimsDe(id)));
        const dims = { w: ANCHO_TARJETA, h: ALTO_TARJETA };
        const cols = Math.max(1, Math.floor(ANCHO_LIENZO / (ANCHO_TARJETA + SEPARACION)));
        for (let fila = 0; fila < 60; fila++) {
            for (let col = 0; col < cols; col++) {
                const x = col * (ANCHO_TARJETA + SEPARACION);
                const y = fila * (ALTO_TARJETA + SEPARACION);
                const rect = this._rect({ x, y }, dims);
                if (!colocadas.some((r) => this._seSolapan(rect, r))) {
                    return { x, y };
                }
            }
        }
        return { x: 0, y: 0 };
    }

    // Hueco libre más cercano a 'base' para una tarjeta de tamaño 'dims',
    // evitando cualquier rectángulo de 'colocadas'. Si 'base' ya está libre
    // se devuelve tal cual (así, al desaparecer el conflicto, la vecina
    // regresa EXACTAMENTE a su sitio).
    _espacioLibreCercano(base, dims, colocadas) {
        const cabe = (pos) =>
            !colocadas.some((r) => this._seSolapan(this._rect(pos, dims), r));
        if (cabe(base)) {
            return { x: base.x, y: base.y };
        }
        const paso = 30;
        for (let radio = 1; radio <= 60; radio++) {
            for (let dx = -radio; dx <= radio; dx++) {
                for (let dy = -radio; dy <= radio; dy++) {
                    // solo el anillo exterior de este radio
                    if (Math.abs(dx) !== radio && Math.abs(dy) !== radio) {
                        continue;
                    }
                    const pos = {
                        x: Math.max(0, base.x + dx * paso),
                        y: Math.max(0, base.y + dy * paso),
                    };
                    if (cabe(pos)) {
                        return pos;
                    }
                }
            }
        }
        return { x: base.x, y: base.y };
    }

    _corregirEncimados() {
        // Al cargar posiciones guardadas: si dos tarjetas caen encimadas,
        // reubica la segunda al espacio libre más cercano. En la carga
        // inicial ninguna tarjeta está abierta todavía (todas colapsadas).
        const colocadas = [];
        for (const id of this.state.mesa) {
            const p = this.state.posiciones[id];
            if (!p) {
                continue;
            }
            const dims = this._dimsDe(id);
            const [x0, y0] = this._limitar(p.x, p.y);
            const libre = this._espacioLibreCercano({ x: x0, y: y0 }, dims, colocadas);
            this.state.posiciones[id] = libre;
            colocadas.push(this._rect(libre, dims));
        }
    }

    // Reacomoda SOLO visualmente a las vecinas que una tarjeta abierta
    // solapa por su mayor tamaño, y las regresa a su posición guardada en
    // cuanto NINGUNA tarjeta abierta las solapa. Nunca escribe en el
    // servidor: posicion_x/posicion_y quedan intactas.
    _reconciliarVecinas() {
        const abiertas = this.state.mesa.filter((id) => this.estaAbierta(id));
        if (!abiertas.length) {
            // Sin tarjetas abiertas no hay nada que empujar: todo vuelve a su
            // posición guardada.
            if (Object.keys(this.state.posicionesTemporales).length) {
                this.state.posicionesTemporales = {};
            }
            return;
        }

        // Anclas fijas: NUNCA se mueven.
        //  - las tarjetas abiertas: son con las que trabaja el sinodal
        //    (aunque sobresalgan del ancho del lienzo, requisito explícito).
        //  - la tarjeta que se está arrastrando justo ahora.
        const fijas = new Set(abiertas);
        if (this.state.arrastrando) {
            fijas.add(this.state.arrastrando);
        }
        const colocadas = [...fijas]
            .filter((id) => this.state.mesa.includes(id))
            .map((id) => this._rect(this._posEfectiva(id), this._dimsDe(id)));

        // Mismo patrón greedy que _corregirEncimados: recorremos las vecinas
        // en el orden estable de state.mesa; si una choca con algo ya
        // colocado (una ancla, o una vecina ya reubicada => cascada C->D),
        // la mandamos al hueco libre más cercano a SU posición guardada.
        const temporales = {};
        for (const id of this.state.mesa) {
            if (fijas.has(id) || !this.state.posiciones[id]) {
                continue;
            }
            const guardada = this._posGuardada(id);
            const dims = this._dimsDe(id);
            const destino = this._espacioLibreCercano(guardada, dims, colocadas);
            colocadas.push(this._rect(destino, dims));
            if (destino.x !== guardada.x || destino.y !== guardada.y) {
                temporales[id] = destino;
            }
        }

        this.state.posicionesTemporales = temporales;
    }

    // ---- arrastre con Pointer Events (mouse + táctil) ------------------

    alPresionar(ev, examenId) {
        // Ignora botones secundarios del mouse (para toque/lápiz button es 0).
        if (ev.button && ev.button !== 0) {
            return;
        }
        const lienzo = this.lienzoRef.el;
        if (!lienzo) {
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const rect = lienzo.getBoundingClientRect();
        // Desde donde se VE (puede estar desplazada temporalmente por una
        // vecina abierta), no desde su posición guardada: así no pega un
        // brinco al empezar a arrastrar.
        const p = this._posEfectiva(examenId);
        this._arrastre = {
            examenId,
            pointerId: ev.pointerId,
            // desfase entre el puntero y la esquina de la tarjeta
            desfaseX: ev.clientX - rect.left - p.x,
            desfaseY: ev.clientY - rect.top - p.y,
            movido: false,
        };
        this.state.arrastrando = examenId;
        // Listeners en window: no se pierde el puntero aunque el dedo/cursor
        // salga de la tarjeta o esta se vuelva a renderizar.
        window.addEventListener("pointermove", this._onMove, { passive: false });
        window.addEventListener("pointerup", this._onUp);
        window.addEventListener("pointercancel", this._onUp);
    }

    _alMover(ev) {
        const a = this._arrastre;
        if (!a || ev.pointerId !== a.pointerId) {
            return;
        }
        ev.preventDefault();

        // Primer movimiento real de una tarjeta que estaba desplazada por una
        // vecina abierta: soltamos su desplazamiento temporal (el desfase ya
        // se calculó desde donde se veía, así que no brinca) y de aquí en
        // adelante manda el puntero.
        if (!a.movido) {
            this._soltarTemporal(a.examenId);
        }

        const rect = this.lienzoRef.el.getBoundingClientRect();
        let [x, y] = this._limitar(
            ev.clientX - rect.left - a.desfaseX,
            ev.clientY - rect.top - a.desfaseY
        );

        // No permitir soltar la tarjeta encima de otra: si el destino choca,
        // se intenta deslizar solo en X, luego solo en Y, y si nada libra se
        // mantiene la última posición válida de este arrastre.
        const dims = this._dimsDe(a.examenId);
        const obstaculos = this.state.mesa
            .filter((id) => id !== a.examenId && this.state.posiciones[id])
            .map((id) => this._rect(this._posEfectiva(id), this._dimsDe(id)));
        const libre = (px, py) =>
            !obstaculos.some((r) => this._seSolapan(this._rect({ x: px, y: py }, dims), r));

        if (obstaculos.length && !libre(x, y)) {
            const prev = this.state.posiciones[a.examenId] || { x, y };
            if (libre(x, prev.y)) {
                y = prev.y;
            } else if (libre(prev.x, y)) {
                x = prev.x;
            } else if (libre(prev.x, prev.y)) {
                x = prev.x;
                y = prev.y;
            }
            // Si ni la posición previa libra (arranque ya encimado), se deja
            // pasar el movimiento crudo: mejor arrastrable que congelada.
        }

        a.movido = true;
        this.state.posiciones[a.examenId] = { x, y };
    }

    async _alSoltar(ev) {
        const a = this._arrastre;
        if (!a || (ev.pointerId !== undefined && ev.pointerId !== a.pointerId)) {
            return;
        }
        this._quitarListenersGlobales();
        this._arrastre = null;
        this.state.arrastrando = null;
        if (!a.movido) {
            return;
        }
        const p = this.state.posiciones[a.examenId];
        // (0,0) es el centinela de "sin posición": si la tarjeta acabó justo
        // ahí, la empujamos 1px para que sí se persista.
        const x = p.x === 0 && p.y === 0 ? 1 : p.x;
        // La tarjeta cambió de posición guardada: recalcular si alguna vecina
        // abierta ahora la solapa (o la dejó de solapar).
        this._reconciliarVecinas();
        await this.orm.write("taekwondo.examen", [a.examenId], {
            posicion_x: x,
            posicion_y: p.y,
        });
    }

    _quitarListenersGlobales() {
        window.removeEventListener("pointermove", this._onMove);
        window.removeEventListener("pointerup", this._onUp);
        window.removeEventListener("pointercancel", this._onUp);
    }

    // ---- callbacks del panel -----------------------------------------

    async onCriterioGuardado(examenId) {
        // Solo repreguntamos por ESTE examen (4 filas), no por todo el
        // evento de nuevo: mismo espíritu de "batch, no uno por uno" pero
        // aplicado a la actualización puntual que sí necesitamos aquí.
        const criterios = await this.orm.searchRead(
            "taekwondo.criterio_calificacion",
            [["examen_id", "=", examenId]],
            ["calificacion"]
        );
        this.state.progreso[examenId] = criterios.filter((c) => c.calificacion).length;
    }

    onResultadoCambiado(examenId, valor) {
        // A diferencia de onCriterioGuardado, aquí NO volvemos a preguntarle
        // al servidor: el Panel ya sabe con certeza qué valor acaba de
        // escribir (él mismo lo mandó), así que nos lo pasa directo y solo
        // actualizamos el estado local. rosterPorExamenId[examenId] es la
        // MISMA referencia de objeto que vive dentro de state.roster (el
        // getter solo la busca, no la copia), así que mutarla aquí sí
        // dispara el re-render de quien esté leyendo ese dato.
        const item = this.rosterPorExamenId[examenId];
        if (item) {
            item.resultado = valor;
        }
    }

    onMejorExamenCambiado(examenId, valor) {
        // Mismo mecanismo que onResultadoCambiado: el Panel ya sabe el
        // valor exacto, así que solo actualizamos la referencia local.
        const item = this.rosterPorExamenId[examenId];
        if (item) {
            item.mejorExamen = valor;
        }
    }
}

registry.category("actions").add("mi_primer_modulo.tablero_calificacion", TableroCalificacion);
