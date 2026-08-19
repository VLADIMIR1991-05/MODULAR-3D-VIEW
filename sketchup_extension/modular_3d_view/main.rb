require 'sketchup.rb'
require 'fileutils'
require 'json'
require 'time'

module Modular3D
  module View
    VIEW_URL = 'https://modular-3d-view.lenin19910527.workers.dev'.freeze

    def self.mm(value)
      (value.to_f * 25.4).round(2)
    end

    def self.safe_entity_name(entity, index)
      name = entity.name.to_s.strip
      name = entity.definition.name.to_s.strip if name.empty? && entity.respond_to?(:definition)
      name.empty? ? "Pieza #{index + 1}" : name
    end

    def self.material_name(entity)
      material = entity.material
      return material.display_name.to_s unless material.nil?
      return '' unless entity.respond_to?(:definition)

      face = entity.definition.entities.grep(Sketchup::Face).find { |item| !item.material.nil? }
      face && face.material ? face.material.display_name.to_s : ''
    end

    def self.collect_components(entities, parent_path = [], pieces = [], depth = 0)
      return pieces if depth > 12

      instances = entities.select { |entity| entity.is_a?(Sketchup::Group) || entity.is_a?(Sketchup::ComponentInstance) }
      instances.each_with_index do |entity, index|
        name = safe_entity_name(entity, index)
        definition = entity.definition
        bounds = definition.bounds
        dimensions = [mm(bounds.width), mm(bounds.height), mm(bounds.depth)].sort.reverse
        persistent_id = entity.respond_to?(:persistent_id) ? entity.persistent_id.to_s : entity.entityID.to_s
        path = parent_path + [name]
        piece = {
          id: "SU-#{persistent_id}",
          name: name,
          definition: definition.name.to_s,
          path: path,
          parent: parent_path.last,
          length_mm: dimensions[0],
          width_mm: dimensions[1],
          thickness_mm: dimensions[2],
          axis_x_mm: mm(bounds.width),
          axis_y_mm: mm(bounds.height),
          axis_z_mm: mm(bounds.depth),
          material: material_name(entity),
          visible: entity.visible?,
          layer: entity.layer ? entity.layer.name.to_s : '',
          instance_type: entity.is_a?(Sketchup::Group) ? 'group' : 'component'
        }
        pieces << piece
        collect_components(definition.entities, path, pieces, depth + 1)
      end
      pieces
    end

    def self.model_metadata(model, safe_name)
      bounds = model.bounds
      pieces = collect_components(model.entities)
      {
        schema: 'modular-3d-view-metadata',
        version: 1,
        generated_at: Time.now.utc.iso8601,
        source: 'SketchUp',
        project: {
          name: model.title.to_s.strip.empty? ? safe_name : model.title.to_s.strip,
          units: 'mm',
          width_mm: mm(bounds.width),
          height_mm: mm(bounds.height),
          depth_mm: mm(bounds.depth),
          piece_count: pieces.length
        },
        pieces: pieces
      }
    end

    def self.publish
      model = Sketchup.active_model
      if model.nil? || model.entities.length.zero?
        UI.messagebox('Abre un modelo SketchUp antes de publicarlo.')
        return
      end

      default_name = model.title.to_s.strip
      default_name = 'modelo_modular_3d' if default_name.empty?
      parent = UI.select_directory(title: 'Selecciona dónde preparar el modelo')
      return unless parent

      safe_name = default_name.gsub(/[^0-9A-Za-z_\-]/, '_')
      export_dir = File.join(parent, "#{safe_name}_MODULAR3D_VIEW")
      FileUtils.mkdir_p(export_dir)
      dae_path = File.join(export_dir, "#{safe_name}.dae")
      options = {
        triangulated_faces: true,
        doublesided_faces: true,
        edges: false,
        author_attribution: false,
        texture_maps: true,
        preserve_instancing: true
      }

      Sketchup.set_status_text('Preparando modelo para MODULAR-3D VIEW…')
      success = model.export(dae_path, options)
      Sketchup.set_status_text('')
      unless success
        UI.messagebox('SketchUp no pudo preparar el modelo. Guarda el SKP e inténtalo nuevamente.')
        return
      end

      metadata_path = File.join(export_dir, "#{safe_name}.metadata.json")
      File.open(metadata_path, 'w:utf-8') do |file|
        file.write(JSON.pretty_generate(model_metadata(model, safe_name)))
      end

      UI.openURL(VIEW_URL)
      UI.messagebox(
        "Modelo preparado correctamente.\n\n" \
        "En MODULAR-3D VIEW pulsa 'Abrir exportación de SketchUp' y selecciona esta carpeta:\n\n#{export_dir}\n\n" \
        "Se incluyeron las medidas, materiales y jerarquía técnica de las piezas.\n\n" \
        'El archivo SKP original no fue modificado.'
      )
    rescue StandardError => error
      Sketchup.set_status_text('')
      UI.messagebox("No se pudo preparar el modelo:\n#{error.message}")
    end

    unless file_loaded?(__FILE__)
      command = UI::Command.new('Publicar en MODULAR-3D VIEW') { publish }
      command.tooltip = 'Publicar en MODULAR-3D VIEW'
      command.status_bar_text = 'Prepara el modelo abierto para visualizarlo en la web.'
      toolbar = UI::Toolbar.new('MODULAR-3D VIEW')
      toolbar.add_item(command)
      toolbar.show
      UI.menu('Extensions').add_item(command)
      file_loaded(__FILE__)
    end
  end
end
