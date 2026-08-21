import calendar
import logging
from datetime import date

from odoo import api, fields, models

_logger = logging.getLogger(__name__)


class TaekwondoAlumno(models.Model):
    _name = 'taekwondo.alumno'
    _description = 'Alumno de la academia'

    name = fields.Char(string='Nombre completo', required=True)
    id_alumno = fields.Char(string='ID Alumno')
    foto = fields.Image(string='Foto', max_width=1024, max_height=1024)
    partner_id = fields.Many2one(
        comodel_name='res.partner',
        string='Contacto de facturación',
        required=True,
    )
    fecha_nacimiento = fields.Date(string='Fecha de nacimiento')
    edad = fields.Integer(compute='_compute_edad', string='Edad')
    telefono = fields.Char(string='Teléfono')
    contacto_emergencia_nombre = fields.Char(string='Nombre del contacto de emergencia')
    contacto_emergencia_telefono = fields.Char(string='Teléfono de emergencia')
    cinta_actual = fields.Selection(
        selection=[
            ('blanca', 'Blanca'),
             ('naranja', 'Naranja'),
            ('naranja_avanzada', 'Naranja avanzada'),
            ('amarilla', 'Amarilla'),
            ('amarilla_avanzada', 'Amarilla avanzada'),
            ('verde', 'Verde'),
            ('verde_avanzada', 'Verde avanzada'),
            ('azul', 'Azul'),
            ('azul_avanzada', 'Azul avanzada'),
            ('roja', 'Roja'),
            ('roja_avanzada', 'Roja avanzada'),
            ('negra', 'Negra'),
        ],
        string='Cinta actual',
        default='blanca',
    )
    fecha_ingreso = fields.Date(string='Fecha de ingreso')
    examen_ids = fields.One2many(
        comodel_name='taekwondo.examen',
        inverse_name='alumno_id',
        string='Exámenes de cinta',
    )
    activo = fields.Boolean(string='Alumno activo', default=True)
    cuota_mensual = fields.Float(string='Cuota mensual')
    ultimo_cobro_generado = fields.Date(
        string='Último cobro generado',
        readonly=True,
        copy=False,
    )

    @api.depends('fecha_nacimiento')
    def _compute_edad(self):
        hoy = fields.Date.context_today(self)
        for alumno in self:
            if not alumno.fecha_nacimiento:
                alumno.edad = 0
                continue
            nacimiento = alumno.fecha_nacimiento
            cumplio_este_anio = (hoy.month, hoy.day) >= (nacimiento.month, nacimiento.day)
            alumno.edad = hoy.year - nacimiento.year - (0 if cumplio_este_anio else 1)

    def _cron_generar_facturas_mensuales(self):
        hoy = fields.Date.context_today(self)
        if hoy.day != 1:
            return

        alumnos = self.search([
            ('activo', '=', True),
            ('partner_id', '!=', False),
        ])
        producto = self.env['product.product'].search(
            [('default_code', '=', 'MENS-TKD')], limit=1,
        )
        ultimo_dia_mes = calendar.monthrange(hoy.year, hoy.month)[1]

        for alumno in alumnos:
            cobrado_este_mes = (
                alumno.ultimo_cobro_generado
                and alumno.ultimo_cobro_generado.month == hoy.month
                and alumno.ultimo_cobro_generado.year == hoy.year
            )
            if cobrado_este_mes:
                continue

            if not producto:
                _logger.warning(
                    "No se encontró el producto con Referencia interna 'MENS-TKD'; "
                    "no se pudo generar el cobro de %s",
                    alumno.name,
                )
                continue

            dia_vencimiento = alumno.fecha_ingreso.day if alumno.fecha_ingreso else 1
            dia_vencimiento = min(dia_vencimiento, ultimo_dia_mes)
            fecha_vencimiento = date(hoy.year, hoy.month, dia_vencimiento)

            line_vals = {
                'product_id': producto.id,
                'quantity': 1,
            }
            if alumno.cuota_mensual > 0:
                line_vals['price_unit'] = alumno.cuota_mensual

            self.env['account.move'].create({
                'move_type': 'out_invoice',
                'partner_id': alumno.partner_id.id,
                'invoice_date_due': fecha_vencimiento,
                'invoice_line_ids': [(0, 0, line_vals)],
            })
            alumno.ultimo_cobro_generado = hoy
