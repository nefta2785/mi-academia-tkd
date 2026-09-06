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
const ALTO_TARJETA = 140;      // huella aproximada de una tarjeta colapsada
const ANCHO_LIENZO = 1400;
const ALTO_LIENZO_MAX = 3000;
const SEPARACION = 16;
const HOLGURA_ENCIMADO = 40;   // px de traslape tolerado antes de considerar "encimadas"

export class TableroCalificacion extends Component {
    static template = "mi_primer_modulo.TableroCalificacion";
    static components = { PanelCalificacion };
    static props = {
        ...standardActionServiceProps,
    };

    setup() {
        this.orm = useService("orm");
        this.lienzoRef = useRef("lienzo");
        this.ANCHO_LIENZO = ANCHO_LIENZO;

        this.state = useState({
            cargando: true,
            roster: [],
            ordenPor: "edad",
            rosterColapsado: false,
            // 'mesa': exámenes en la mesa. 'posiciones': {examenId: {x, y}} en px
            // dentro del lienzo. 'tarjetasAbiertas': cuáles muestran el panel
            // completo inline. 'expandido': tarjeta a pantalla completa, o null.
            // 'arrastrando': examenId que se está arrastrando (para el z-index).
            mesa: [],
            posiciones: {},
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
    }

    estaAbierta(examenId) {
        return this.state.tarjetasAbiertas.includes(examenId);
    }

    alternarTarjeta(examenId) {
        if (this.state.tarjetasAbiertas.includes(examenId)) {
            this.state.tarjetasAbiertas = this.state.tarjetasAbiertas.filter((id) => id !== examenId);
        } else {
            this.state.tarjetasAbiertas.push(examenId);
        }
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
        let maxAbajo = 700;
        for (const id of this.state.mesa) {
            const p = this.state.posiciones[id];
            if (!p) {
                continue;
            }
            const alto = this.estaAbierta(id) ? 720 : ALTO_TARJETA;
            maxAbajo = Math.max(maxAbajo, p.y + alto);
        }
        return Math.min(maxAbajo + 80, ALTO_LIENZO_MAX);
    }

    posicionTarjeta(examenId) {
        const p = this.state.posiciones[examenId] || { x: 0, y: 0 };
        let z = 10;
        if (this.state.arrastrando === examenId) {
            z = 30;
        } else if (this.estaAbierta(examenId)) {
            z = 20;
        }
        return `left:${p.x}px; top:${p.y}px; width:${ANCHO_TARJETA}px; z-index:${z};`;
    }

    _choca(x, y, colocadas) {
        return colocadas.some(
            (c) =>
                Math.abs(c.x - x) < ANCHO_TARJETA - HOLGURA_ENCIMADO &&
                Math.abs(c.y - y) < ALTO_TARJETA - HOLGURA_ENCIMADO
        );
    }

    _limitar(x, y) {
        const maxX = Math.max(0, ANCHO_LIENZO - ANCHO_TARJETA);
        const maxY = Math.max(0, this.altoLienzo - ALTO_TARJETA);
        return [Math.max(0, Math.min(x, maxX)), Math.max(0, Math.min(y, maxY))];
    }

    _siguienteSlot() {
        const colocadas = this.state.mesa
            .map((id) => this.state.posiciones[id])
            .filter(Boolean);
        const cols = Math.max(1, Math.floor(ANCHO_LIENZO / (ANCHO_TARJETA + SEPARACION)));
        for (let fila = 0; fila < 60; fila++) {
            for (let col = 0; col < cols; col++) {
                const x = col * (ANCHO_TARJETA + SEPARACION);
                const y = fila * (ALTO_TARJETA + SEPARACION);
                if (!this._choca(x, y, colocadas)) {
                    return { x, y };
                }
            }
        }
        return { x: 0, y: 0 };
    }

    _espacioLibreCercano(x, y, colocadas) {
        if (!this._choca(x, y, colocadas)) {
            return { x, y };
        }
        const paso = 30;
        for (let radio = 1; radio <= 60; radio++) {
            for (let dx = -radio; dx <= radio; dx++) {
                for (let dy = -radio; dy <= radio; dy++) {
                    // solo el anillo exterior de este radio
                    if (Math.abs(dx) !== radio && Math.abs(dy) !== radio) {
                        continue;
                    }
                    const [nx, ny] = this._limitar(x + dx * paso, y + dy * paso);
                    if (!this._choca(nx, ny, colocadas)) {
                        return { x: nx, y: ny };
                    }
                }
            }
        }
        return { x, y };
    }

    _corregirEncimados() {
        // Al cargar posiciones guardadas: si dos tarjetas caen encimadas,
        // reubica la segunda al espacio libre más cercano.
        const colocadas = [];
        for (const id of this.state.mesa) {
            const p = this.state.posiciones[id];
            if (!p) {
                continue;
            }
            const [x0, y0] = this._limitar(p.x, p.y);
            const libre = this._espacioLibreCercano(x0, y0, colocadas);
            this.state.posiciones[id] = libre;
            colocadas.push(libre);
        }
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
        const p = this.state.posiciones[examenId] || { x: 0, y: 0 };
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
        const rect = this.lienzoRef.el.getBoundingClientRect();
        const [x, y] = this._limitar(
            ev.clientX - rect.left - a.desfaseX,
            ev.clientY - rect.top - a.desfaseY
        );
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
